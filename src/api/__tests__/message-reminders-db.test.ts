import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { buildApnsPayload, type ApnsNotificationInput } from "../notifications/apns-client.js";
import { authorizeDesktopPushNotification } from "../notifications/authorization.js";
const url = process.env.TEST_DB_URL;
if (url) process.env.DB_URL = url;
const dbm = url ? await import("../db/client.js") : null;
const core = url ? await import("../db.js") : null;
const reminders = url ? await import("../notifications/reminders.js") : null;
const worker = url ? await import("../notifications/worker.js") : null;
const preferences = url ? await import("../db/room-notification-preferences.js") : null;
const pool = dbm?.pool;
const options = { skip: !url, concurrency: false };
if (url) {
  test.beforeEach(async () => {
    await pool!.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
    await migrate(dbm!.db, { migrationsFolder: path.resolve("drizzle") });
  });
  test.after(() => pool!.end());
}
async function seed() {
  const room = await core!.createProjectWithName("github.com/test/reminders");
  const account = await core!.upsertAccount({ provider: "github", provider_user_id: "one", login: "one" });
  const other = await core!.upsertAccount({ provider: "github", provider_user_id: "two", login: "two" });
  for (const [id, owner] of [["device-one", account.id], ["device-two", account.id], ["device-other", other.id]]) {
    await pool!.query(`INSERT INTO desktop_push_devices (id,account_id,installation_id,device_token,token_hash,bundle_id,environment,enabled,last_registered_at,created_at,updated_at)
      VALUES ($1,$2,$1,$1,$1,'chat.letagents.desktop','production',true,now(),now(),now())`, [id, owner]);
  }
  const message = await core!.addMessage(room.id, "Sender", "Private message body", { source: "human" });
  const input = { accountId: account.id, roomId: room.id, messageNumber: Number(message.id.slice(4)), dueAt: new Date(Date.now() + 3600000).toISOString() };
  return { account, other, room, input };
}
async function create(input: Parameters<NonNullable<typeof reminders>["createMessageReminder"]>[0]) {
  const result = await reminders!.createMessageReminder(input); assert.ok(result.reminder); return result.reminder;
}
async function due(id: string) { await pool!.query("UPDATE message_reminders SET due_at=now()-interval '1 second' WHERE id=$1", [id]); }
async function rows(table: string) { return (await pool!.query(`SELECT * FROM ${table} ORDER BY id`)).rows; }
const client = (sent: ApnsNotificationInput[], status = 200) => ({ send: async (input: ApnsNotificationInput) => { sent.push(input); return { status, reason: null, apnsId: "test" }; } });

test("real due claims never fire early, enqueue once across workers, and isolate account devices", options, async () => {
  const { input, other } = await seed(); const reminder = await create(input);
  await create({ ...input, accountId: other.id });
  await reminders!.enqueueDueReminders(); assert.equal((await rows("desktop_reminder_deliveries")).length, 0);
  await due(reminder.id);
  await Promise.all([reminders!.enqueueDueReminders(), reminders!.enqueueDueReminders()]);
  await reminders!.enqueueDueReminders();
  const deliveries = await rows("desktop_reminder_deliveries");
  assert.deepEqual(new Set(deliveries.map(r => r.device_id)), new Set(["device-one", "device-two"]));
  assert.ok(deliveries.every(r => r.body === "" && r.sender === "" && r.room_display_name === ""));
  const [a, b] = await Promise.all([worker!.claimReminderDeliveries("a"), worker!.claimReminderDeliveries("b")]);
  assert.equal(a.length + b.length, 2);
  assert.equal(new Set([...a, ...b].map(r => r.id)).size, 2);
  const sent: ApnsNotificationInput[] = [];
  for (const [owner, batch] of [["a", a], ["b", b]] as const) for (const row of batch) await worker!.deliverNotification(client(sent), owner, row, async () => "allow");
  assert.equal(sent.length, 2); assert.ok(sent.every(r => r.body === "Private message body" && r.reminder));
  assert.match(JSON.stringify(buildApnsPayload(sent[0]!)), /Reminder: Sender/);
  assert.equal((await worker!.claimReminderDeliveries("c")).length, 0);
  assert.ok((await rows("desktop_reminder_deliveries")).every(r => r.state === "delivered" && r.body === ""));
  assert.equal((await reminders!.listMessageReminders(other.id, 0))[0]?.state, "pending");
});
test("a muted room suppresses ordinary alerts but still delivers personal reminders", options, async () => {
  const { input, other } = await seed();
  for (const accountId of [input.accountId, other.id]) {
    await pool!.query(`INSERT INTO account_room_recents (account_id,room_id,first_opened_at,last_opened_at,updated_at)
      VALUES ($1,$2,now(),now(),now())`, [accountId, input.roomId]);
  }
  await core!.addMessage(input.roomId, "Sender", "Before mute", { source: "human" });
  assert.deepEqual((await rows("desktop_push_notifications")).map(row => row.device_id).sort(),
    ["device-one", "device-other", "device-two"]);

  await preferences!.setRoomNotificationPreference(input.accountId, input.roomId, { level: "muted" });
  const message = await core!.addMessage(input.roomId, "Sender", "Remember this muted message", { source: "human" });
  const messageNumber = Number(message.id.slice(4));
  const ordinary = await rows("desktop_push_notifications");
  assert.deepEqual(ordinary.filter(row => row.message_number === messageNumber).map(row => row.device_id),
    ["device-other"], "mute suppresses only the requesting account's ordinary alerts");

  const reminder = await create({ ...input, messageNumber });
  await due(reminder.id);
  await reminders!.enqueueDueReminders();
  const claimed = await worker!.claimReminderDeliveries("muted-reminder-worker");
  assert.deepEqual(claimed.map(row => row.device_id).sort(), ["device-one", "device-two"]);
  assert.ok(claimed.every(row => row.reminder_id === reminder.id));
  const sent: ApnsNotificationInput[] = [];
  for (const row of claimed) {
    await worker!.deliverNotification(client(sent), "muted-reminder-worker", row, async () => "allow");
  }
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(notification => notification.deviceToken).sort(), ["device-one", "device-two"]);
  assert.ok(sent.every(notification => notification.reminder
    && notification.roomId === input.roomId
    && notification.messageId === message.id
    && notification.body === "Remember this muted message"));
  const delivered = await rows("desktop_reminder_deliveries");
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every(row => row.state === "delivered" && row.body === ""));
  assert.equal((await preferences!.getRoomNotificationPreference(input.accountId, input.roomId)).level, "muted");
  assert.deepEqual(await rows("desktop_push_notifications"), ordinary);
});
test("ordinary queued alerts and two reminders for one message keep separate delivery identities", options, async () => {
  const { input } = await seed();
  await pool!.query(`INSERT INTO desktop_push_notifications (id,device_id,room_id,message_number,room_display_name,sender,body,state,attempt_count,next_attempt_at,created_at,updated_at)
    VALUES ('original','device-one',$1,$2,'Original room','Original sender','Original body','retry',3,now(),now(),now())`, [input.roomId,input.messageNumber]);
  const original = await rows("desktop_push_notifications");
  const a = await create(input), b = await create(input); await due(a.id); await due(b.id);
  await reminders!.enqueueDueReminders(); assert.equal((await rows("desktop_reminder_deliveries")).length, 4);
  assert.deepEqual(await rows("desktop_push_notifications"), original);
  const claimed = await worker!.claimReminderDeliveries("worker");
  const sent: ApnsNotificationInput[] = [];
  for (const row of claimed) await worker!.deliverNotification(client(sent), "worker", row, async () => "allow");
  assert.equal(new Set(sent.map(r => r.notificationId)).size, 4); assert.ok(sent.every(r => r.notificationId !== "original"));
  assert.deepEqual(await rows("desktop_push_notifications"), original);
});
test("cancellation before due or after claim prevents sending and never deletes another account's reminder", options, async () => {
  const { input, other } = await seed(); const a = await create(input);
  await reminders!.deleteMessageReminder(other.id, a.id); assert.equal((await reminders!.listMessageReminders(input.accountId,0)).length,1);
  await reminders!.deleteMessageReminder(input.accountId,a.id); await reminders!.enqueueDueReminders(); assert.equal((await rows("desktop_reminder_deliveries")).length,0);
  const b = await create(input); await due(b.id); await reminders!.enqueueDueReminders(); const claimed = await worker!.claimReminderDeliveries("w");
  await reminders!.deleteMessageReminder(input.accountId,b.id);
  const sent: ApnsNotificationInput[]=[]; for (const row of claimed) await worker!.deliverNotification(client(sent),"w",row,async()=>"allow");
  assert.equal(sent.length,0);
});
test("access revoked at delivery emits no preview and redacts only that account's delivery backlog", options, async () => {
  const { input, other }=await seed(); const a=await create(input), b=await create({...input,accountId:other.id}); await due(a.id); await due(b.id); await reminders!.enqueueDueReminders();
  const claimed=await worker!.claimReminderDeliveries("w"), sent: ApnsNotificationInput[]=[];
  const denied=claimed.find(r=>r.account_id===input.accountId)!;
  await worker!.deliverNotification(client(sent),"w",denied,()=>authorizeDesktopPushNotification({accountId:input.accountId,roomId:input.roomId},{
    getProject:async()=>({id:input.roomId} as any),getAccount:async()=>({account_id:input.accountId,provider:"github",login:"one",provider_access_token:"test"}),
    resolveAccess:async({freshCollaboratorCheck})=>{assert.equal(freshCollaboratorCheck,true);return {isRepoBacked:true,decision:{kind:"deny"}} as any;},
  }));
  assert.equal(sent.length,0);
  const deliveries=await rows("desktop_reminder_deliveries"); assert.equal(deliveries.find(r=>r.id===denied.id).state,"dead");
  assert.equal(deliveries.find(r=>r.reminder_id===b.id).state,"processing");
});
test("hidden or removed messages are dropped, including a retry; retry policy and cleanup are shared", options, async () => {
  const {input}=await seed(); const a=await create(input); await due(a.id); await reminders!.enqueueDueReminders();
  let claimed=await worker!.claimReminderDeliveries("w"); const sent: ApnsNotificationInput[]=[];
  await worker!.deliverNotification(client(sent,503),"w",claimed[0]!,async()=>"allow");
  let row=(await rows("desktop_reminder_deliveries")).find(r=>r.id===claimed[0]!.id); assert.equal(row.state,"retry"); assert.equal(row.attempt_count,1);
  await pool!.query("UPDATE messages SET text='', agent_prompt_kind='auto' WHERE room_id=$1",[input.roomId]);
  await pool!.query("UPDATE desktop_reminder_deliveries SET next_attempt_at=now() WHERE state='retry'");
  claimed=await worker!.claimReminderDeliveries("w2"); for(const r of claimed) await worker!.deliverNotification(client(sent),"w2",r,async()=>"allow");
  assert.equal(sent.length,1); assert.equal((await rows("message_reminders")).length,0);
  await pool!.query("UPDATE messages SET text='visible', agent_prompt_kind=null WHERE room_id=$1",[input.roomId]);
  const b=await create(input); await pool!.query("DELETE FROM messages WHERE room_id=$1",[input.roomId]);
  assert.equal((await reminders!.listMessageReminders(input.accountId,0)).length,0);
  assert.ok(b.id);
});
test("future bounds and pending cap are checked transactionally; personal changes leave room data alone", options, async()=>{
  const {input}=await seed();
  const roomTables = ["messages", "message_human_read_ranges", "message_thread_reads", "room_agent_work", "room_agent_delivery_sessions"];
  const snapshot = async () => Promise.all(roomTables.map(async table => (await pool!.query(`SELECT row_to_json(record) AS value FROM ${table} AS record ORDER BY row_to_json(record)::text`)).rows));
  const before = await snapshot();
  for(const dueAt of [new Date(Date.now()-1000).toISOString(),new Date(Date.now()+31*86400000).toISOString()]) assert.equal((await reminders!.createMessageReminder({...input,dueAt})).error,"invalid_due_at");
  await pool!.query(`INSERT INTO message_reminders (id,account_id,room_id,message_number,due_at) SELECT 'cap-'||n,$1,$2,$3,now()+interval '1 hour' FROM generate_series(1,99) n`,[input.accountId,input.roomId,input.messageNumber]);
  const results=await Promise.all([reminders!.createMessageReminder(input),reminders!.createMessageReminder(input)]);
  assert.equal(results.filter(r=>r.reminder).length,1); assert.equal(results.filter(r=>r.error==="reminder_limit").length,1);
  const created = results.find(result => result.reminder)?.reminder;
  assert.ok(created);
  await reminders!.deleteMessageReminder(input.accountId, created.id);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await rows("desktop_push_notifications"),[]);
});
test("cap locks time out rather than wait without bounds", options, async()=>{
  const {input}=await seed(); const lock=await pool!.connect();
  try {await lock.query("BEGIN");await lock.query("SELECT pg_advisory_xact_lock(1380798020,hashtext($1))",[input.accountId]);
    await assert.rejects(reminders!.createMessageReminder(input),(error:any)=>(error.code??error.cause?.code)==="55P03");
  } finally {await lock.query("ROLLBACK");lock.release();}
});
test("terminal reminder deliveries use existing retention; device-free reminders still become due", options, async()=>{
 const {input}=await seed();const a=await create(input);await due(a.id);await reminders!.enqueueDueReminders();
 const claimed=await worker!.claimReminderDeliveries("w");
 await worker!.recordResult(claimed[0]!,"w",{status:200,reason:null,apnsId:"done"});
 await worker!.recordResult(claimed[1]!,"w",{status:400,reason:"BadPayload",apnsId:null});
 await pool!.query("UPDATE desktop_reminder_deliveries SET delivered_at=now()-interval '31 days',updated_at=now()-interval '91 days'");
 await worker!.cleanupTerminalNotifications();assert.equal((await rows("desktop_reminder_deliveries")).length,0);
 await pool!.query("UPDATE desktop_push_devices SET enabled=false");const b=await create(input);await due(b.id);await reminders!.enqueueDueReminders();
 assert.equal((await rows("desktop_reminder_deliveries")).length,0);assert.equal((await rows("message_reminders")).find(r=>r.id===b.id).state,"due");
});

test("cleanup expires only due reminders older than 30 days and cascades their deliveries", options, async()=>{
 const {input}=await seed();
 const expired=await create(input), recent=await create(input), pending=await create(input);
 await due(expired.id);await due(recent.id);await reminders!.enqueueDueReminders();
 await pool!.query("UPDATE message_reminders SET due_at=now()-interval '31 days' WHERE id=ANY($1)",[[expired.id,pending.id]]);
 assert.equal((await rows("desktop_reminder_deliveries")).length,4);
 await worker!.cleanupTerminalNotifications();
 assert.deepEqual(new Set((await rows("message_reminders")).map(row=>row.id)),new Set([recent.id,pending.id]));
 const deliveries=await rows("desktop_reminder_deliveries");assert.equal(deliveries.length,2);
 assert.ok(deliveries.every(row=>row.reminder_id===recent.id));
});
