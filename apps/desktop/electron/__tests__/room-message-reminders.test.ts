import assert from "node:assert/strict";
import test from "node:test";
async function load(t:test.TestContext,local=false){
 const calls:any[]=[];
 t.mock.module("../main/auth.js",{namedExports:{apiFetch:async(path:string,options?:RequestInit)=>{calls.push({path,...options});return {ok:true};}}});
 t.mock.module("../main/rooms/local-store.js",{namedExports:{resolveLocalAwareRoomStorageMode:async()=>({effectiveMode:local?"local":"cloud"}),cloudRoomIdentifierForStorage:()=>"canonical/room"}});
 const subject=await import(new URL(`../main/rooms/reminders.js?${t.name}`,import.meta.url).href);return {subject,calls};
}
test("reminders send one absolute time and use personal list/delete routes",async t=>{
 const {subject,calls}=await load(t);const dueAt="2026-10-03T09:00:00.000Z",id="12345678-1234-4234-8234-123456789abc";
 await subject.createDesktopMessageReminder("alias","msg_12",dueAt);await subject.getDesktopMessageReminders(50);await subject.deleteDesktopMessageReminder(id);
 assert.deepEqual(calls,[{path:"/rooms/canonical%2Froom/messages/msg_12/reminders",method:"POST",body:JSON.stringify({due_at:dueAt})},{path:"/desktop/reminders?offset=50"},{path:`/desktop/reminders/${id}`,method:"DELETE"}]);
});
test("local messages and malformed targets make no network call",async t=>{
 const {subject,calls}=await load(t,true);await assert.rejects(subject.createDesktopMessageReminder("room","msg_1",new Date().toISOString()),/cloud room/);
 for(const id of ["msg_0","msg_2147483648","pending","msg_1/path"])await assert.rejects(subject.createDesktopMessageReminder("room",id,new Date().toISOString()));
 assert.throws(()=>subject.deleteDesktopMessageReminder("../other"));assert.throws(()=>subject.getDesktopMessageReminders(-1));assert.deepEqual(calls,[]);
});
