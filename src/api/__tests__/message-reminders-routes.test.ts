import assert from "node:assert/strict";
import test from "node:test";
process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerMessageReminderRoutes } = await import("../routes/rooms/messages/reminders.js");
const { requiredAgentSessionRouteCapability } = await import("../request/agent-session-route-capabilities.js");
const { resolveProjectRepoRoomAccessDecision } = await import("../rooms/access.js");
const id="12345678-1234-4234-8234-123456789abc";
function harness(options: { deny?: boolean; access?: string; fail?: unknown }={}) {
 const routes:any[]=[]; const calls:any[]=[];
 const row={id,account_id:"me",room_id:"canonical",message_number:12,due_at:new Date(Date.now()+3600000).toISOString(),state:"pending",created_at:"now"};
 registerMessageReminderRoutes(Object.fromEntries(["get","post","delete"].map(method=>[method,(path:any,handler:any)=>routes.push({method,path,handler})])) as any,{
   resolveCanonicalRoomRequestId:async()=>"canonical",resolveRoomOrReply:async()=>({id:"canonical"}),
   requireParticipant:async(_req:any,res:any)=>{if(options.deny)res.status(403).json({error:"denied"});return !options.deny;},
   emitProjectMessage:()=>{throw Error("must never publish")},queueMessagePinInvalidation:()=>{throw Error("must never invalidate")},
 } as any,{
   create:async(input:any)=>{calls.push(["create",input]);if(options.fail)throw options.fail;return {reminder:row};},
   remove:async(account:any,target:any)=>{calls.push(["remove",account,target]);if(options.fail)throw options.fail;},
   list:async(account:any)=>{calls.push(["list",account]);return [row];},
   authorize:async()=>{calls.push(["fresh-worker-access"]);return options.access??"allow";},
   project:async()=>({id:"github.com/org/repo"}),
   access:async(input:any)=>resolveProjectRepoRoomAccessDecision(input, {
     getGitRoomBindingForRoom:async()=>null,
     resolveRepoRoomAccessDecision:async(optionsInput)=>{
       calls.push(["session-access",optionsInput.sessionAccount?.account_id,optionsInput.freshCollaboratorCheck]);
       if(options.access==="retry")throw Error("Unavailable");
       return {kind:options.access==="deny"?"private_repo_no_access":"allow"};
     },
   }),
   message:async()=>{calls.push(["preview"]);return {sender:"Sender",body:"private",displayText:null,roomName:"Room",threadRoot:2};},
 } as any);
 async function request(method:string,path:string,auth:string|null="session",body:any={due_at:row.due_at}){
  const route=routes.find(r=>r.method===method&&(r.path instanceof RegExp?r.path.test(path):r.path===path||r.path==="/desktop/reminders/:id"&&path.startsWith("/desktop/reminders/")));
  assert.ok(route);const params=route.path instanceof RegExp?Object.fromEntries(path.match(route.path)!.slice(1).map((v,i)=>[i,v])):{id:path.split('/').at(-1)};
  const req={params,body,query:{},authKind:auth,sessionAccount:{account_id:"me"},headers:{}};
  const res={code:200,body:null as any,status(code:number){this.code=code;return this;},json(body:any){this.body=body;return this;}};
  await route.handler(req,res);return res;
 }
 return {request,calls};
}
const createPath="/rooms/alias/messages/msg_12/reminders";
test("all personal routes reject agent owner tokens and anonymous calls before storage",async()=>{
 for(const auth of [null,"owner_token","agent_session"]){const h=harness();for(const [method,path] of [["post",createPath],["get","/desktop/reminders"],["delete",`/desktop/reminders/${id}`]])assert.equal((await h.request(method!,path!,auth)).code,auth?403:401);assert.deepEqual(h.calls,[]);}
 assert.equal(requiredAgentSessionRouteCapability("POST",createPath),null);
 assert.equal(requiredAgentSessionRouteCapability("GET","/desktop/reminders"),null);
});
test("creation uses canonical room and session account, accepts only absolute time, and emits no room work",async()=>{
 const h=harness();assert.equal((await h.request("post",createPath)).code,201);
 assert.equal(h.calls[0][1].accountId,"me");assert.equal(h.calls[0][1].roomId,"canonical");
 for(const body of [{due_at:"tomorrow"},{due_at:"2026-10-03T09:00:00"},{due_at:new Date().toISOString(),account_id:"other"}])assert.equal((await h.request("post",createPath,"session",body)).code,400);
 assert.equal(h.calls.length,1);const denied=harness({deny:true});assert.equal((await denied.request("post",createPath)).code,403);assert.deepEqual(denied.calls,[]);
});
test("listing rechecks access before loading text and cancellation is constrained to the session owner",async()=>{
 for(const access of ["deny","retry"]){const h=harness({access});const result=await h.request("get","/desktop/reminders");assert.equal(result.body.reminders[0].preview,null);assert.ok(!h.calls.some(c=>c[0]==="preview"));}
 const h=harness();const result=await h.request("get","/desktop/reminders");assert.equal(result.body.reminders[0].preview.thread_root_id,"msg_2");assert.deepEqual(h.calls[0],["list","me"]);
 await h.request("delete",`/desktop/reminders/${id}`);assert.deepEqual(h.calls.at(-1),["remove","me",id]);
});
test("lock timeouts map to 503 for both creation and cancellation",async()=>{
 const h=harness({fail:{cause:{code:"55P03"}}});for(const [method,path] of [["post",createPath],["delete",`/desktop/reminders/${id}`]]){const result=await h.request(method!,path!);assert.equal(result.code,503);assert.equal(result.body.code,"reminder_busy");}
});

test("two list reads use the session room-access path without fresh collaborator checks",async()=>{
 const h=harness();
 for(let i=0;i<2;i++){
   const response=await h.request("get","/desktop/reminders");
   assert.equal(response.body.reminders[0].preview.snippet,"private");
 }
 assert.deepEqual(h.calls.filter(c=>c[0]==="session-access"),[["session-access","me",undefined],["session-access","me",undefined]]);
 assert.ok(!h.calls.some(c=>c[0]==="fresh-worker-access"));
});
