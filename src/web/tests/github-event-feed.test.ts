import assert from 'node:assert/strict'
import test from 'node:test'
import { groupActivity, githubUrl, matchesActivity, mergeActivityEvents, type ActivityEvent } from '../../../shared/ui/activity/model'
import { mapGitHubRoomEventPayload } from '../../../apps/desktop/electron/main/rooms/events'
const url = 'https://github.com/BrosInCode/letagents/pull/42'
const at = (minute: number) => `2026-10-11T10:${String(minute).padStart(2,'0')}:00Z`
function event(id: string, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id, event_type:'pull_request', action:'opened', github_object_id:'42', github_object_url:url, title:'Activity view', state:'open', actor_login:'author', created_at:at(0), provider_event_at:at(0), head_sha:'sha', metadata:{}, linked_task_id:null, ...overrides }
}
function job(id: string, attempt: number, status: string, minute: number): ActivityEvent {
  return event(id,{event_type:'workflow_job',action:status,github_object_id:'19',github_object_url:'https://github.com/BrosInCode/letagents/actions/runs/90/job/19',title:'build',state:status,created_at:at(minute),provider_event_at:at(minute),metadata:{repository:'brosincode/letagents',pull_request_url:url.toLowerCase(),run_id:'90',run_attempt:attempt,job_id:'19',status,conclusion:status==='completed'?'success':null,run_url:'https://github.com/BrosInCode/letagents/actions/runs/90',workflow_name:'CI',pull_request_head_sha:'sha'}})
}
function review(id: string, actor: string, state: string, minute: number): ActivityEvent {
  return event(`review-${id}`,{event_type:'pull_request_review',action:'submitted',actor_login:actor,state,provider_event_at:at(minute),metadata:{review_id:id,review_commit_id:'sha'}})
}

test('desktop preserves all provider identity and time fields for the shared Activity view', () => {
  const payload = job('job',2,'in_progress',3)
  const desktop = mapGitHubRoomEventPayload(payload)
  assert.equal(desktop?.eventType,'workflow_job')
  assert.equal(desktop?.providerEventAt, at(3))
  assert.equal(desktop?.headSha,'sha')
  assert.deepEqual(desktop?.metadata,payload.metadata)
})

test('PR URL casing, late CI deliveries and retries fold into one PR without regressing completion', () => {
  const group = groupActivity([event('pr'),job('complete',1,'completed',2),job('late-queued',1,'queued',8),job('new-attempt',2,'in_progress',9)])[0]
  assert.equal(groupActivity([event('pr'),job('complete',1,'completed',2)]).length,1)
  assert.equal(group.runs.length,2)
  assert.equal(group.runs[0].jobs[0].state,'Passed')
  assert.equal(group.runs[1].jobs[0].state,'Running')
  assert.equal(group.status,'CI running')
})

test('a completed job alone cannot claim the whole CI run passed', () => {
  assert.equal(groupActivity([job('complete',1,'completed',2)])[0].runs[0].state,'Awaiting run update')
})

test('review comments are grouped by review ID, updated/deleted by comment ID and bodies never enter presentation', () => {
  const comment = event('c1',{event_type:'pull_request_review_comment',action:'created',actor_login:'reviewer',provider_event_at:at(2),metadata:{review_id:'1',comment_id:'9',body:'do not show me'}})
  const edited = {...comment,id:'c2',action:'edited',provider_event_at:at(3)}
  const removed = {...comment,id:'c3',action:'deleted',provider_event_at:at(4)}
  let group = groupActivity([event('pr'),review('1','reviewer','commented',1),comment,edited])[0]
  assert.equal(group.reviews.length,1)
  assert.equal(group.reviews[0].comments,1)
  assert.equal(group.reviews[0].update,'Comment edited')
  assert.ok(!JSON.stringify(group.reviews).includes('do not show me'))
  group = groupActivity([event('pr'),review('1','reviewer','commented',1),comment,edited,removed])[0]
  assert.equal(group.reviews[0].comments,0)
})

test('thread resolution/reopening updates the original review, preserving deleted comments', () => {
  const comments = [{id:'9',review_id:'1',actor_login:'reviewer'}]
  const thread = event('t1',{event_type:'pull_request_review_thread',action:'resolved',provider_event_at:at(3),metadata:{thread_id:'thread-9',resolved:true,comments}})
  const removed = event('c1',{event_type:'pull_request_review_comment',action:'deleted',provider_event_at:at(2),metadata:{review_id:'1',comment_id:'9'}})
  const reopened = {...thread,id:'t2',action:'unresolved',provider_event_at:at(4),metadata:{...thread.metadata,resolved:false}}
  const result = groupActivity([event('pr'),removed,thread,reopened])[0].reviews[0]
  assert.equal(result.comments,0)
  assert.equal(result.resolved,0)
  assert.equal(result.unresolved,1)
  assert.equal(result.update,'Discussion reopened')
})

test('approval does not silence another reviewer; only dismissal or approval clears their change request', () => {
  const blocker=review('1','alice','changes_requested',1), approval=review('2','bob','approved',2)
  assert.equal(groupActivity([event('pr'),blocker,approval])[0].attention,true)
  const dismissed={...blocker,id:'dismissed',action:'dismissed',state:'dismissed',created_at:at(5)}
  assert.equal(groupActivity([event('pr'),blocker,approval,dismissed])[0].attention,false)
  assert.equal(groupActivity([event('pr',{head_sha:'new-sha'}),blocker,approval])[0].attention,true)
  assert.equal(groupActivity([event('pr'),blocker,review('3','alice','commented',4)])[0].attention,true)
})

test('a comment on an older review cannot override the same reviewer’s newer verdict', () => {
  const old=review('1','alice','changes_requested',1), approval=review('2','alice','approved',2)
  const comment=event('comment',{event_type:'pull_request_review_comment',action:'created',provider_event_at:at(5),metadata:{review_id:'1',comment_id:'9'}})
  assert.equal(groupActivity([event('pr'),old,approval,comment])[0].attention,false)
})

test('filters and history merges preserve real events and reject unsafe URLs', () => {
  const open = event('pr'), merged = event('merged',{action:'closed',state:'merged',provider_event_at:at(5),metadata:{merged:true}})
  assert.ok(matchesActivity(groupActivity([open])[0],'review','activity'))
  const group = groupActivity(mergeActivityEvents([open],[merged,open]))[0]
  assert.equal(group.events.length,2)
  assert.ok(matchesActivity(group,'merged','author'))
  assert.equal(matchesActivity(group,'review',''),false)
  assert.equal(githubUrl('javascript:alert(1)'),null)
  assert.equal(githubUrl('https://github.com.evil.test/owner/repo'),null)
})

test('workflows sharing a display name cannot mask each other’s failure', () => {
  function run(id: string, workflow: string, conclusion: string) {
    return event(id,{event_type:'workflow_run',action:'completed',state:conclusion,metadata:{run_id:id,run_attempt:1,workflow_id:workflow,workflow_name:'CI',status:'completed',conclusion,pull_request_url:url,pull_request_head_sha:'sha'}})
  }
  const groups=groupActivity([event('pr'),run('90','workflow-1','failure'),run('91','workflow-2','success')])
  assert.equal(groups[0].attention,true)
  assert.equal(groups[0].status,'Build failed')
  assert.equal(groupActivity([event('pr'),run('90','workflow-1','failure'),run('91','workflow-1','success')])[0].attention,false)
})


test('a partial review history does not invent the PR lifecycle', () => {
  const group=groupActivity([review('1','alice','commented',1)])[0]
  assert.equal(group.status,'Review activity')
  assert.equal(group.inReview,false)
})

test('deleted comment tombstones survive delayed edits with equal provider timestamps', () => {
  const base=event('deleted',{event_type:'pull_request_review_comment',action:'deleted',provider_event_at:at(1),created_at:at(2),metadata:{review_id:'1',comment_id:'9'}})
  const late={...base,id:'late-edit',action:'edited',created_at:at(3)}
  const group=groupActivity([event('pr'),base,late])[0]
  assert.equal(group.reviews[0].comments,0)
  assert.equal(group.reviews[0].update,'Comment removed')
})

test('dismissing the latest effective review does not revive a superseded blocker', () => {
  const old=review('1','alice','changes_requested',1), next=review('2','alice','changes_requested',2)
  const dismissed={...next,id:'dismiss-2',action:'dismissed',state:'dismissed',provider_event_at:null,created_at:at(8),metadata:{...next.metadata,review_submitted_at:at(2)}}
  assert.equal(groupActivity([event('pr'),old,next,dismissed])[0].attention,false)
})

test('the provider run conclusion wins over a failed continue-on-error job', () => {
  const failedJob=job('job-failed',1,'completed',2)
  failedJob.metadata={...failedJob.metadata,conclusion:'failure'}
  const passed=event('run-passed',{event_type:'workflow_run',action:'completed',state:'success',metadata:{run_id:'90',run_attempt:1,status:'completed',conclusion:'success',pull_request_url:url,pull_request_head_sha:'sha'}})
  assert.equal(groupActivity([event('pr'),failedJob,passed])[0].attention,false)
})

import { createGitHubTimeline, githubArtifactKey, githubUpdateRows, githubChatHighlights, githubChatHighlightLimit } from '../../../shared/grouped-github-updates'
import { parseGitHubEventPresentation } from '../src/components/room/githubEventMessage'
import { chatSenderRole, avatarInitials } from '../../../shared/chat-appearance'
function roomUpdate(id: number, text: string, link = url) { return { id: `msg_${id}`, source: 'github', sender: 'github', timestamp: at(id), text: `${text} ${link}` } }
const parseRoomEvent = (m: ReturnType<typeof roomUpdate>) => m.source === 'github' ? parseGitHubEventPresentation(m) : null
const roomPR = (id: number) => roomUpdate(id, 'PR #42 opened in BrosInCode/letagents: Quiet room updates')

test('room groups preserve history and row order, coalesce canonical artifact URLs, and end at conversation/day boundaries', () => {
  const group = createGitHubTimeline<ReturnType<typeof roomUpdate>, ReturnType<typeof roomUpdate>>()
  const first = roomPR(1), other = roomUpdate(2,'PR #9 opened in BrosInCode/other: Another task','https://github.com/BrosInCode/other/pull/9')
  const merged = roomUpdate(3,'PR #42 merged by EmmyMay in BrosInCode/letagents', `${url.toLowerCase()}#event-1`)
  const human = {...roomPR(4), source:'browser', sender:'github'}
  const next = {...roomPR(6), timestamp:'2026-10-12T10:00:00Z'}
  const entries = group([first,other,merged,human,roomPR(5),next], m=>m,parseRoomEvent,'room')
  assert.equal(entries.length,4)
  assert.equal(entries[1],human)
  const rows = githubUpdateRows([first,other,merged],parseRoomEvent)
  assert.equal(rows.length,2)
  assert.deepEqual(rows[0].messages.map(m=>m.id),['msg_1','msg_3'])
  assert.equal(rows[0].title,'Quiet room updates')
  assert.equal(rows[0].event.statusLabel,'merged')
  assert.equal(rows[1].title,'Another task')
})

test('pagination reuses the mounted group and anchor, while later block splits never duplicate keys', () => {
  const group = createGitHubTimeline<ReturnType<typeof roomUpdate>, ReturnType<typeof roomUpdate>>()
  const before = group([roomPR(3),roomPR(4)],m=>m,parseRoomEvent,'room') as any[]
  const after = group([roomPR(1),roomPR(2),roomPR(3),roomPR(4),roomPR(5)],m=>m,parseRoomEvent,'room') as any[]
  assert.equal(after[0].id,before[0].id)
  assert.equal(after[0].anchorId,'msg_3')
  const split = group([roomPR(1),{...roomPR(2),source:'browser'},roomPR(3),roomPR(4)],m=>m,parseRoomEvent,'room') as any[]
  assert.equal(new Set(split.map(e=>e.id)).size,split.length)
  assert.equal(split[2].id,before[0].id)
  assert.equal(split[0].anchorId,'msg_1')
  const otherRoom = group([roomPR(1),roomPR(3)],m=>m,parseRoomEvent,'other') as any[]
  assert.equal(otherRoom[0].anchorId,'msg_1')
})

test('artifact grouping never merges an unrelated run, repository, unknown URL, or mismatched repository', () => {
  const original = parseRoomEvent(roomPR(1))!
  assert.notEqual(githubArtifactKey(original,'a'),githubArtifactKey({...original,url:'https://github.com/BrosInCode/letagents/actions/runs/42'},'b'))
  assert.equal(githubArtifactKey({...original,url:'https://example.org/BrosInCode/letagents/pull/42'},'c'),'message:c')
  assert.equal(githubArtifactKey({...original,repository:'other/repo'},'d'),'message:d')
  assert.equal(githubArtifactKey({...original,url:null},'e'),'message:e')
})

test('a recovered run updates in place and a comment does not regress a merged PR', () => {
  const run='https://github.com/BrosInCode/letagents/actions/runs/90'
  const failed=roomUpdate(1,'Check "build" (GitHub Actions) failure in BrosInCode/letagents',run)
  const passed=roomUpdate(2,'Check "build" (GitHub Actions) success in BrosInCode/letagents',run)
  assert.equal(githubUpdateRows([failed,passed],parseRoomEvent)[0].event.statusLabel,'Success')
  const merged=roomUpdate(3,'PR #42 merged in BrosInCode/letagents')
  const comment=roomUpdate(4,'Willow commented on PR #42 in BrosInCode/letagents: "Looks good"')
  assert.equal(githubUpdateRows([merged,comment],parseRoomEvent)[0].event.statusLabel,'merged')
})

test('sender palette uses authenticated ownership, keeps own agents incoming, and handles signed-out/unknown identities', () => {
  assert.equal(chatSenderRole({human:true,agent:false,login:'EMMYMAY',viewerLogin:'EmmyMay'}),'self')
  assert.equal(chatSenderRole({human:true,agent:false,login:'Willow',viewerLogin:'EmmyMay'}),'human')
  assert.equal(chatSenderRole({human:true,agent:false,viewerLogin:'EmmyMay'}),'human')
  assert.equal(chatSenderRole({human:true,agent:false,outgoing:true}),'self')
  assert.equal(chatSenderRole({human:false,agent:true,agentKey:'EmmyMay/stone',viewerLogin:'emmymay'}),'own-agent')
  assert.equal(chatSenderRole({human:false,agent:true,agentKey:'Willow/stone',viewerLogin:'EmmyMay'}),'other-agent')
  assert.equal(chatSenderRole({human:false,agent:true,agentKey:'EmmyMay/stone'}),'other-agent')
  assert.equal(avatarInitials('Willow May'),'WM')
  assert.equal(avatarInitials('Willow'),'WI')
})


test('separate check jobs on the same workflow cannot overwrite each other', () => {
  const events = [
    { id: 'msg_1', timestamp: '2026-10-12T10:00:00Z', text: 'Check "build" failure in BrosInCode/letagents\nhttps://github.com/BrosInCode/letagents/actions/runs/10' },
    { id: 'msg_2', timestamp: '2026-10-12T10:01:00Z', text: 'Check "integration-tests" success in BrosInCode/letagents\nhttps://github.com/BrosInCode/letagents/actions/runs/10' },
  ];
  const rows = githubUpdateRows(events, message => parseGitHubEventPresentation({ ...message, source: "github", sender: "github" }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event.statusLabel, 'Failure');
  assert.equal(rows[1].event.statusLabel, 'Success');
});

const checkMessage = (id: number, name: string, state: string, run = '90') => roomUpdate(id,
  `Check "${name}" (GitHub Actions) ${state} in BrosInCode/letagents`,
  `https://github.com/BrosInCode/letagents/actions/runs/${run}/job/${id}`)

test('Chat condenses checks by run, keeps individual outcomes and silences recovered and cancelled runs', () => {
  const messages = [checkMessage(1,'build','failure'), checkMessage(2,'integration-tests','success'), checkMessage(3,'build','success')]
  let rows = githubUpdateRows(messages.slice(0,2),parseRoomEvent)
  let highlights = githubChatHighlights(rows)
  assert.equal(highlights.length,1)
  assert.deepEqual(highlights[0].checks.map(check=>[check.name,check.state]),[['build','Failed'],['integration-tests','Passed']])
  rows = githubUpdateRows(messages,parseRoomEvent)
  assert.equal(githubChatHighlights(rows).length,0)
  assert.equal(rows.flatMap(row=>row.messages).length,3,'compaction never drops the original notifications')
  assert.equal(githubChatHighlights(githubUpdateRows([checkMessage(4,'build','cancelled','91')],parseRoomEvent)).length,0)
})

test('Chat bounds highlights even when a burst contains many failed workflows', () => {
  const messages = Array.from({length:20},(_,index)=>checkMessage(index+1,'build','failure',String(90+index)))
  const rows = githubUpdateRows(messages,parseRoomEvent)
  const highlights = githubChatHighlights(rows)
  assert.equal(highlights.length,githubChatHighlightLimit)
  assert.deepEqual(highlights.map(item=>item.title),['Workflow #107','Workflow #108','Workflow #109'])
  assert.equal(rows.length,20)
})

test('Chat uses explicit PR context without letting duplicate legacy check events obscure it', () => {
  const failedJob = job('job-failed',1,'completed',2)
  failedJob.metadata = {...failedJob.metadata, conclusion:'failure',head_ref:'feature/activity'}
  const legacy = event('legacy-check',{event_type:'check_run',action:'completed',state:'failure',title:'build',github_object_url:failedJob.github_object_url,metadata:{same_repo_pull_request_numbers:[42]},provider_event_at:at(2)})
  const activity = [event('pr'),failedJob,legacy]
  const groups = groupActivity(activity)
  const original = JSON.stringify(groups)
  const rows = githubUpdateRows([checkMessage(1,'build','failure')],parseRoomEvent)
  const highlight = githubChatHighlights(rows,groups)[0]
  assert.equal(highlight.label,'#42')
  assert.equal(highlight.title,'Activity view')
  assert.equal(highlight.branch,'feature/activity')
  assert.equal(highlight.checks.length,1)
  assert.equal(highlight.checks[0].state,'Failed')
  assert.equal(JSON.stringify(groups),original,'the Activity projection remains unchanged')
  assert.deepEqual(groups.flatMap(group=>group.events).map(event=>event.id).sort(),activity.map(event=>event.id).sort())
})

test('Chat suppresses an old failing notification after a successful retry or a changed PR head', () => {
  const failedJob=job('failed',1,'completed',2)
  failedJob.metadata={...failedJob.metadata,conclusion:'failure'}
  const rows=githubUpdateRows([checkMessage(1,'build','failure')],parseRoomEvent)
  const recovered=job('recovered',2,'completed',4)
  assert.equal(githubChatHighlights(rows,groupActivity([event('pr'),failedJob,recovered])).length,0)
  assert.equal(githubChatHighlights(rows,groupActivity([event('pr',{head_sha:'new-sha'}),failedJob])).length,0)
})

test('Chat keeps a merged milestone while routine PR changes stay in the digest', () => {
  const messages=[roomPR(1),roomUpdate(2,'PR #42 received new commits in BrosInCode/letagents'),roomUpdate(3,'PR #42 merged in BrosInCode/letagents')]
  assert.equal(githubChatHighlights(githubUpdateRows(messages.slice(0,2),parseRoomEvent)).length,0)
  const highlights=githubChatHighlights(githubUpdateRows(messages,parseRoomEvent))
  assert.equal(highlights.length,1)
  assert.equal(highlights[0].merged,true)
  assert.equal(highlights[0].title,'Quiet room updates')
})

test('Chat anchors a merge to its actual notification even with earlier blocks and later comments', () => {
  const merged=roomUpdate(3,'PR #42 merged in BrosInCode/letagents')
  const messages=[roomPR(1),merged,roomUpdate(4,'Willow commented on PR #42 in BrosInCode/letagents: "Looks good"')]
  const groups=groupActivity([event('opened'),event('merged',{action:'closed',state:'closed',metadata:{merged:true},provider_event_at:at(3)})])
  assert.equal(githubChatHighlights(githubUpdateRows(messages.slice(0,1),parseRoomEvent),groups).length,0)
  const highlights=githubChatHighlights(githubUpdateRows(messages,parseRoomEvent),groups)
  assert.equal(highlights.length,1)
  assert.equal(highlights[0].sourceMessageId,merged.id)
  assert.equal(highlights[0].time,merged.timestamp)
})

test('Chat picks the latest matching notification once and selects Activity via recorded job IDs', () => {
  const failedJob=job('failed-job',1,'completed',2)
  failedJob.metadata={...failedJob.metadata,conclusion:'failure'}
  const messages=[checkMessage(1,'build','failure'),roomPR(2),checkMessage(3,'tests','failure')]
  const rows=githubUpdateRows(messages,parseRoomEvent)
  const highlights=githubChatHighlights(rows,groupActivity([failedJob]))
  assert.equal(highlights.length,1)
  assert.equal(highlights[0].sourceMessageId,messages[2].id)
  assert.equal(highlights[0].url,url.toLowerCase())
  assert.equal(highlights[0].activityEventId,'failed-job','PR context can come entirely from workflow metadata')
  const legacy=event('legacy-check',{event_type:'check_run',action:'completed',state:'failure',github_object_url:failedJob.github_object_url,metadata:null})
  const fallback=githubChatHighlights(githubUpdateRows([messages[0]],parseRoomEvent),groupActivity([legacy]))[0]
  assert.match(fallback.url,/\/actions\/runs\/90$/)
  assert.equal(fallback.activityEventId,'legacy-check','canonical run links still select a recorded job event')
})

test('Chat never invents a PR association from a task or an unsafe or mismatched repository URL', () => {
  const message=roomUpdate(1,'Check "build" (GitHub Actions) failure in BrosInCode/other linked to task_42','https://github.com/BrosInCode/other/actions/runs/90/job/19')
  const highlight=githubChatHighlights(githubUpdateRows([message],parseRoomEvent),groupActivity([event('pr'),job('failed',1,'completed',2)]))[0]
  assert.equal(highlight.title,'Workflow #90')
  assert.notEqual(highlight.label,'#42')
  for (const link of ['javascript:alert(1)','https://github.com.evil.test/BrosInCode/letagents/actions/runs/90','https://github.com/Wrong/repo/actions/runs/90']) {
    const bad=roomUpdate(2,'Check "build" (GitHub Actions) failure in BrosInCode/letagents',link)
    assert.equal(githubChatHighlights(githubUpdateRows([bad],parseRoomEvent)).length,0)
  }
})

test('fallback workflow summaries open the failed job instead of a passing job in the same run', () => {
  const messages=[checkMessage(10,'lint','success'),checkMessage(20,'build','failure'),checkMessage(30,'tests','success')]
  const activity=messages.map((message,index)=>event(`check-${index}`,{event_type:'check_run',action:'completed',state:index===1?'failure':'success',title:['lint','build','tests'][index],github_object_url:parseRoomEvent(message)!.url,metadata:null,provider_event_at:at(index+1)}))
  const highlight=githubChatHighlights(githubUpdateRows(messages,parseRoomEvent),groupActivity(activity))[0]
  assert.equal(highlight.activityEventId,'check-1')
  assert.equal(highlight.sourceMessageId,messages[2].id)
})
