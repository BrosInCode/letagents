import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRenderer, createSSRApp, h, nextTick, ssrContextKey } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createServer } from 'vite';
import { reminderDueAt, reminderPresets } from '../src/domain/message-reminder-time';
let Menu:any, Section:any, Chat:any, reminders:any, toasts:any;
before(async()=>{
 const vite=await createServer({root:fileURLToPath(new URL('../..',import.meta.url)),appType:'custom',logLevel:'silent',server:{middlewareMode:true}});
 try { Menu=(await vite.ssrLoadModule('/renderer/src/components/desktop/content/MessageReminderMenu.vue')).default;
 Section=(await vite.ssrLoadModule('/renderer/src/components/desktop/content/MessageRemindersSection.vue')).default;
 Chat=(await vite.ssrLoadModule('/renderer/src/components/desktop/content/DesktopChatMessage.vue')).default;
 toasts=await vite.ssrLoadModule('/renderer/src/composables/useDesktopActionToasts.ts');
 reminders=await vite.ssrLoadModule('/renderer/src/composables/useMessageReminders.ts'); } finally {await vite.close();}
});
test('four presets send absolute times; tomorrow uses local calendar time across DST',()=>{
 const old=process.env.TZ;process.env.TZ='America/New_York';
 try {
 assert.equal(reminderPresets.length,4);
 const now=new Date('2026-03-07T17:00:00Z');
 for(const [preset,minutes] of [['20m',20],['1h',60],['3h',180]] as const)assert.equal(Date.parse(reminderDueAt(preset,now))-now.getTime(),minutes*60000);
 assert.equal(reminderDueAt('tomorrow',now),'2026-03-08T13:00:00.000Z');
 assert.equal(reminderDueAt('tomorrow',new Date('2026-10-31T17:00:00Z')),'2026-11-01T14:00:00.000Z');
 } finally {if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
});
test('account changes discard late lists; create and cancel use their personal IPC and refresh',async()=>{
 const old=globalThis.window;let release:any;const calls:any[]=[];
 Object.assign(globalThis,{window:{letagentsDesktop:{room:{getMessageReminders:()=>new Promise(resolve=>{release=resolve;}),createMessageReminder:async(...args:any[])=>calls.push(['create',...args]),deleteMessageReminder:async(...args:any[])=>calls.push(['delete',...args])}}}});
 try {
 reminders.setReminderAccount('one');const read=reminders.refreshMessageReminders();reminders.setReminderAccount('two');
 release({reminders:[{id:'private'}],next_offset:null});await read;assert.deepEqual(reminders.useMessageReminders().state.items,[]);
 (window as any).letagentsDesktop.room.getMessageReminders=async(offset:number)=>{calls.push(['list',offset]);return {reminders:[],next_offset:null};};
 const dueAt=reminderDueAt('20m');await reminders.scheduleMessageReminder('room','msg_2',dueAt);await reminders.removeMessageReminder('id');
 assert.deepEqual(calls,[['create','room','msg_2',dueAt],['list',0],['delete','id'],['list',0]]);
 reminders.setReminderAccount(null);assert.equal(reminders.useMessageReminders().state.items.length,0);
 await assert.rejects(reminders.scheduleMessageReminder('room','msg_1',dueAt),/Sign in/);
 } finally {reminders.setReminderAccount(null);Object.assign(globalThis,{window:old});}
});
test('real submenu handlers open, move focus, return to parent and send the chosen preset',async()=>{
 const oldWindow=globalThis.window,oldDocument=globalThis.document;const focus:string[]=[],sent:any[]=[],emitted:any[]=[];
 Object.assign(globalThis,{window:{innerWidth:800,innerHeight:600,letagentsDesktop:{room:{createMessageReminder:async(...args:any[])=>sent.push(args),getMessageReminders:async()=>({reminders:[],next_offset:null})}}},document:{activeElement:null}});
 const renderer=createRenderer<any,any>({patchProp(){},insert(){},remove(){},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null});
 let vm:any;const app=renderer.createApp({setup(){vm=Menu.setup({room:'room',message:'msg_12'},{expose(){},emit:(...args:any[])=>emitted.push(args)});return()=>h('div');}});app.provide(ssrContextKey,{modules:new Set()});
 try {reminders.setReminderAccount('one');app.mount({});
 const buttons=[0,1,2,3].map(i=>({focus:()=>{focus.push(String(i));(document as any).activeElement=buttons[i];}}));
 vm.trigger.value={getBoundingClientRect:()=>({right:790,top:590}),focus:()=>focus.push('parent')};vm.menu.value={querySelector:()=>buttons[0],querySelectorAll:()=>buttons};
 vm.show();await nextTick();assert.equal(vm.open.value,true);assert.equal(focus.at(-1),'0');assert.deepEqual(vm.position.value,{left:'592px',top:'410px'});
 for(let i=0;i<buttons.length;i++) {
   buttons[i].focus();vm.keydown({key:'ArrowDown',preventDefault(){}});assert.equal(focus.at(-1),String((i+1)%buttons.length));
   vm.keydown({key:'ArrowUp',preventDefault(){}});assert.equal(focus.at(-1),String(i));
 }
 vm.keydown({key:'ArrowLeft',preventDefault(){}});assert.equal(vm.open.value,false);assert.equal(focus.at(-1),'parent');
 vm.show();await nextTick();vm.keydown({key:'Escape',preventDefault(){}});assert.equal(focus.at(-1),'parent');
 await vm.schedule('1h');assert.equal(sent.length,1);assert.equal(sent[0][0],'room');assert.equal(sent[0][1],'msg_12');assert.ok(Math.abs(Date.parse(sent[0][2])-Date.now()-3600000)<1000);assert.equal(emitted[0][0],'scheduled');
 } finally {app.unmount();reminders.setReminderAccount(null);Object.assign(globalThis,{window:oldWindow,document:oldDocument});}
});
test('Inbox renders pending/due controls and escapes personal previews',async()=>{
 reminders.setReminderAccount('one');const state=reminders.useMessageReminders().state;
 state.items=[{id:'one',room_id:'room',message_id:'msg_1',due_at:'2026-10-03T09:00:00Z',state:'pending',preview:{sender:'<Owner>',room_display_name:'Room',snippet:'<script>secret</script>',thread_root_id:null}},{id:'two',room_id:'room',message_id:'msg_2',due_at:'2026-10-01T09:00:00Z',state:'due',preview:null}];
 try {const html=await renderToString(createSSRApp({render:()=>h(Section)}));assert.match(html,/Cancel/);assert.match(html,/Dismiss/);assert.match(html,/Message unavailable/);assert.match(html,/&lt;script&gt;secret&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);}finally{reminders.setReminderAccount(null);}
});

test('scheduling confirms through the shared transient app toast',async()=>{
 const oldWindow=globalThis.window;let expire:any;let timeout=0;
 Object.assign(globalThis,{window:{setTimeout:(callback:any,ms:number)=>{expire=callback;timeout=ms;return 1;},removeEventListener(){}}});
 const renderer=createRenderer<any,any>({patchProp(){},insert(){},remove(){},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null});
 let vm:any;const toast=toasts.useDesktopActionToasts();toast.actionToasts.value=[];
 const app=renderer.createApp({...Chat,setup(props:any,context:any){vm=Chat.setup(props,context);return()=>h('div');}}, {message:{id:'msg_1',text:'Message',sender:'Person',timestamp:'2026-10-02T00:00:00Z',attachments:[]},roomIdentifier:'room'});
 app.provide(ssrContextKey,{modules:new Set()});
 try {
   app.mount({});vm.reminderScheduled('2026-10-03T09:00:00Z');
   assert.equal(toast.actionToasts.value.length,1);
   assert.match(toast.actionToasts.value[0].message,/Reminder set for/);
   assert.equal(toast.actionToasts.value[0].state,'success');assert.equal(timeout,4200);
   expire();assert.deepEqual(toast.actionToasts.value,[]);
 } finally {app.unmount();toast.actionToasts.value=[];Object.assign(globalThis,{window:oldWindow});}
});
test('Inbox hides empty background reads and shows errors or reads after a personal action',async()=>{
 const old=globalThis.window;let release:any;
 Object.assign(globalThis,{window:{letagentsDesktop:{room:{getMessageReminders:()=>new Promise(resolve=>{release=resolve;})}}}});
 reminders.setReminderAccount('one');const state=reminders.useMessageReminders().state;
 const render=()=>renderToString(createSSRApp({render:()=>h(Section)}));
 try {
   assert.doesNotMatch(await render(),/reminders-title/);
   const initial=reminders.refreshMessageReminders();assert.doesNotMatch(await render(),/reminders-title/);
   release({reminders:[],next_offset:null});await initial;assert.doesNotMatch(await render(),/reminders-title/);
   state.error='Try again';assert.match(await render(),/Try again/);
   const retry=reminders.refreshMessageReminders(false,true);assert.match(await render(),/Loading reminders/);
   // A simultaneous focus refresh must keep action feedback until the latest read settles.
   const releaseRetry=release;const focus=reminders.refreshMessageReminders();assert.match(await render(),/Loading reminders/);
   releaseRetry({reminders:[],next_offset:null});await retry;assert.match(await render(),/Loading reminders/);
   release({reminders:[],next_offset:null});await focus;assert.doesNotMatch(await render(),/reminders-title/);
 } finally {reminders.setReminderAccount(null);Object.assign(globalThis,{window:old});}
});
