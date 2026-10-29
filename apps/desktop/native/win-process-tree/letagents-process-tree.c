/*
 * letagents-process-tree.exe: process trees and process identity on Windows.
 *
 * Windows has no process groups that a parent can signal, so killing the
 * process Node spawned leaves what it started (an npm .cmd shim's node, then
 * the native binary) running. This helper puts the process it starts, and
 * everything that process starts, in one Job Object, and ends the job as one.
 * It links only kernel32 and the static C runtime and loads no npm code.
 *
 *   spawn <application> <command-line> [<wait-ms>]
 *       Create a job named after this helper's own pid and creation time,
 *       with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Start <application> with the
 *       exact <command-line>, suspended, put it in the job, then resume it.
 *       The child inherits this helper's standard handles and C runtime
 *       descriptors (so a Node IPC channel passes through) and its current
 *       directory and environment. When the child exits, the rest of the job
 *       is ended, and this helper exits with the child's exit code once the
 *       child and every process the job held have exited. After a `kill`
 *       (which ends the job itself and signals this helper's "ended" event,
 *       and waits for what the job held), it waits for the child and for
 *       anything the job still lists. Whatever it waits for that has not
 *       exited <wait-ms> (default 5000) later is unkillable: this helper then
 *       exits with 0xE04C5401 instead of the child's code. If this helper is
 *       killed, its job handle closes and Windows ends the job. Exit 120:
 *       usage; 121: job setup failed; 122: the child could not be started
 *       (the reason is on stderr).
 *
 *   kill <pid> <creation-time> [<wait-ms>]
 *       Only if process <pid> has that creation time (checked while a handle
 *       to it is held, so the pid cannot be reused in between): end its job
 *       when it is a running helper, else end that one process. Exit 0: the
 *       job was ended, every process it held has exited, and so has the
 *       helper, not reporting its own wait run out; 5: the single process was
 *       ended (it had no job); 2: nothing with that identity exists, nothing
 *       was ended; 3: access denied; 4: unkillable: the job (or the process)
 *       was ended, but <wait-ms> (default 5000) later a process it held, or
 *       the helper, had not exited, or the helper reported unkillable, or
 *       what the job held could not all be held; 120: usage; 121: error.
 *
 *   query <pid> <creation-time>
 *       Print the number of live processes in the job named for that helper.
 *       Exit 0, or 2 when the job no longer exists (every process in it has
 *       ended). Informational: it ends nothing.
 *
 *   info <pid>
 *       Print one JSON line:
 *       {"pid","parentPid","creationTime","exited","image","commandLine"}.
 *       creationTime is the FILETIME (100 ns since 1601, UTC) as a decimal
 *       string; it is the process's birth identity. Exit 0; 2: no such
 *       process; 3: the process exists but cannot be opened; 121: error.
 *
 * Build: apps/desktop/native/win-process-tree/build.mjs (MSVC, /MT /Brepro).
 */
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define EXIT_USAGE 120
#define EXIT_FAILED 121
#define EXIT_NOT_STARTED 122
#define EXIT_ABSENT 2
#define EXIT_DENIED 3
#define EXIT_UNKILLABLE 4
#define EXIT_SINGLE_PROCESS 5
/* spawn's exit code for an unkillable job: it stands in for the child's own
   code, so it is one no program is expected to return. */
static const DWORD EXIT_SPAWN_UNKILLABLE = 0xE04C5401u;
#define DRAIN_MS 5000
#define MAX_DRAIN_MS 600000

typedef unsigned long long u64;

static void write_text(HANDLE out, const char *text) {
  DWORD written = 0;
  size_t length = strlen(text);
  while (length > 0) {
    DWORD chunk = length > 0x7fffffff ? 0x7fffffff : (DWORD)length;
    if (!WriteFile(out, text, chunk, &written, NULL) || written == 0) return;
    text += written;
    length -= written;
  }
}

static void fail_message(const char *what, DWORD error) {
  char line[256];
  _snprintf_s(line, sizeof line, _TRUNCATE, "letagents-process-tree: %s (Windows error %lu)\n", what, (unsigned long)error);
  write_text(GetStdHandle(STD_ERROR_HANDLE), line);
}

static u64 filetime_value(FILETIME time) {
  return ((u64)time.dwHighDateTime << 32) | (u64)time.dwLowDateTime;
}

/* Strict decimal: digits only, no sign, no leading zero (except "0"), fits in max. */
static int parse_decimal(const wchar_t *text, u64 max, u64 *value) {
  u64 result = 0;
  size_t index = 0;
  if (!text || !text[0] || (text[0] == L'0' && text[1])) return 0;
  for (; text[index]; index++) {
    unsigned digit;
    if (text[index] < L'0' || text[index] > L'9' || index >= 20) return 0;
    digit = (unsigned)(text[index] - L'0');
    if (result > (max - digit) / 10) return 0;
    result = result * 10 + digit;
  }
  *value = result;
  return 1;
}

static void job_name(wchar_t *name, size_t size, DWORD pid, u64 creation) {
  _snwprintf_s(name, size, _TRUNCATE, L"Local\\letagents-process-tree-%lu-%llu", (unsigned long)pid, creation);
}

/* A helper's named objects beside its job:
     -ended       (event) set by a kill that ended the job, so the helper
                  bounds its wait even while its own child has not exited;
     -stopping    (mutex) held by whoever is ending the job and waiting on
                  what it held (a kill, or the helper), one at a time;
     -unkillable  (event) set by one that found a process it could not
                  prove exited: every later stop, and the helper's exit, say so. */
static void helper_object_name(wchar_t *name, size_t size, DWORD pid, u64 creation, const wchar_t *suffix) {
  _snwprintf_s(name, size, _TRUNCATE, L"Local\\letagents-process-tree-%lu-%llu-%ls", (unsigned long)pid, creation, suffix);
}

static DWORD job_active_processes(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  ZeroMemory(&accounting, sizeof accounting);
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, NULL)) return (DWORD)-1;
  return accounting.ActiveProcesses;
}

/* Handles to a job's processes, taken while the job still lists them. An
   ended job cannot be waited on through its own counts: TerminateJobObject
   stops counting each process (ActiveProcesses, the process list) at once,
   before it has exited. Only a process handle shows when it is gone. So the
   job is first closed to new processes (an active-process limit of 1: a
   process that would join is ended before it runs), then every process it
   lists is held, then it is ended. `complete` is 0 when any listed process
   could not be held: nothing can then prove the job's processes all exited. */
typedef struct {
  HANDLE *handles;
  DWORD count;
  int complete;
  /* The job's limits before it was closed, to put back if it cannot be ended. */
  int limited;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION previous;
} held_processes;

static void close_job_to_new_processes(HANDLE job, held_processes *held) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  held->limited = 0;
  ZeroMemory(&held->previous, sizeof held->previous);
  if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &held->previous, sizeof held->previous, NULL)) {
    held->complete = 0;
    return;
  }
  limits = held->previous;
  limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 1;
  if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) held->limited = 1;
  else held->complete = 0;
}

/* `close`: close the job to new processes first (not again for a second look after the end). */
static void hold_job_processes(HANDLE job, held_processes *held, int close) {
  DWORD capacity = 64, attempt, index;
  held->handles = NULL;
  held->count = 0;
  held->complete = 1;
  held->limited = 0;
  if (close) close_job_to_new_processes(job, held);
  for (attempt = 0; attempt < 4; attempt++) {
    size_t size = offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList) + (size_t)capacity * sizeof(ULONG_PTR);
    JOBOBJECT_BASIC_PROCESS_ID_LIST *list = (JOBOBJECT_BASIC_PROCESS_ID_LIST *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size);
    if (!list) break;
    if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, (DWORD)size, NULL) && GetLastError() != ERROR_MORE_DATA) {
      HeapFree(GetProcessHeap(), 0, list);
      break;
    }
    /* More processes than room: read again with room for them. */
    if (list->NumberOfAssignedProcesses > list->NumberOfProcessIdsInList) {
      capacity = list->NumberOfAssignedProcesses + 16;
      HeapFree(GetProcessHeap(), 0, list);
      continue;
    }
    held->handles = (HANDLE *)HeapAlloc(GetProcessHeap(), 0, ((size_t)list->NumberOfProcessIdsInList + 1) * sizeof(HANDLE));
    if (!held->handles) {
      HeapFree(GetProcessHeap(), 0, list);
      break;
    }
    for (index = 0; index < list->NumberOfProcessIdsInList; index++) {
      BOOL in_job = FALSE;
      HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)list->ProcessIdList[index]);
      if (!process) {
        /* Invalid parameter: it has exited since the list was read. Anything else leaves it unproved. */
        if (GetLastError() != ERROR_INVALID_PARAMETER) held->complete = 0;
        continue;
      }
      /* The pid may name another process by now (the listed one exited): only a process in this job counts. */
      if (!IsProcessInJob(process, job, &in_job)) {
        held->complete = 0;
        CloseHandle(process);
      } else if (in_job) {
        held->handles[held->count++] = process;
      } else {
        CloseHandle(process);
      }
    }
    HeapFree(GetProcessHeap(), 0, list);
    return;
  }
  /* The list could not be read whole. */
  held->complete = 0;
}

static DWORD remaining_ms(ULONGLONG deadline) {
  ULONGLONG now = GetTickCount64();
  return now >= deadline ? 0 : (DWORD)(deadline - now);
}

/* Wait for each held process until the deadline, then let them go: 1 when every one exited and all were held. */
static int wait_held_processes(held_processes *held, ULONGLONG deadline) {
  int all = held->complete;
  DWORD index;
  for (index = 0; index < held->count; index++) {
    if (WaitForSingleObject(held->handles[index], remaining_ms(deadline)) != WAIT_OBJECT_0) all = 0;
    CloseHandle(held->handles[index]);
  }
  if (held->handles) HeapFree(GetProcessHeap(), 0, held->handles);
  held->handles = NULL;
  held->count = 0;
  return all;
}

/* End the job and wait, until the deadline, for every process it held (and
   `child`, when given), as the job's one stopper at a time: another stopper
   (a second kill, or the helper after a kill) first waits for the one before
   it, so it never takes the list that stopper emptied for a tree that is
   gone, and reads the "unkillable" event that stopper set. Returns 1 only
   when every process was proved to have exited. *error is set when the job
   could not be ended at all.
   Known limit: the job is closed to new processes before it is listed, but
   Windows applies an active-process limit per job, so a descendant that runs
   its children in a nested job of its own can still start one between the
   list and the end. That one is ended, but not waited on. */
static int stop_job(HANDLE job, HANDLE stopping, HANDLE unkillable, HANDLE ended, HANDLE child, ULONGLONG deadline, DWORD *error) {
  held_processes held, late;
  int proved = 1;
  DWORD owned = stopping ? WaitForSingleObject(stopping, remaining_ms(deadline)) : WAIT_FAILED;
  *error = 0;
  if (stopping && owned != WAIT_OBJECT_0 && owned != WAIT_ABANDONED) {
    /* The stopper before this one is still waiting on what it held: end the job anyway; nothing is proved. */
    if (!TerminateJobObject(job, 1)) *error = GetLastError();
    if (ended) SetEvent(ended);
    if (unkillable) SetEvent(unkillable);
    return 0;
  }
  /* No coordination at all, or a stopper that died while it held the job: not provable. */
  if (!stopping || owned == WAIT_ABANDONED) proved = 0;
  if (unkillable && WaitForSingleObject(unkillable, 0) == WAIT_OBJECT_0) proved = 0;
  /* Before the job is ended: afterwards it no longer lists its processes. */
  hold_job_processes(job, &held, 1);
  if (!TerminateJobObject(job, 1)) {
    *error = GetLastError();
    if (held.limited) SetInformationJobObject(job, JobObjectExtendedLimitInformation, &held.previous, sizeof held.previous);
    wait_held_processes(&held, 0);
    if (stopping) ReleaseMutex(stopping);
    return 0;
  }
  if (ended) SetEvent(ended);
  /* An ended job counts nothing, so a limit of 1 lets one process join after
     the end: hold and end that one too. */
  hold_job_processes(job, &late, 0);
  if (late.count) TerminateJobObject(job, 1);
  if (!wait_held_processes(&held, deadline)) proved = 0;
  if (!wait_held_processes(&late, deadline)) proved = 0;
  if (child && WaitForSingleObject(child, remaining_ms(deadline)) != WAIT_OBJECT_0) proved = 0;
  if (!proved && unkillable) SetEvent(unkillable);
  if (stopping) ReleaseMutex(stopping);
  return proved;
}

static int run_spawn(const wchar_t *application, const wchar_t *command_line, DWORD wait_ms) {
  FILETIME creation, exit_time, kernel, user;
  wchar_t name[96], object_name[128];
  HANDLE job, ended, stopping, unkillable, waits[2];
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  STARTUPINFOW own, startup;
  PROCESS_INFORMATION child;
  DWORD flags = CREATE_SUSPENDED;
  DWORD exit_code = 1, stop_error = 0;
  ULONGLONG deadline;
  size_t length;
  wchar_t *mutable_line;

  if (!application[0] || !command_line[0]) return EXIT_USAGE;
  if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit_time, &kernel, &user)) {
    fail_message("cannot read this helper's creation time", GetLastError());
    return EXIT_FAILED;
  }
  job_name(name, sizeof name / sizeof name[0], GetCurrentProcessId(), filetime_value(creation));
  SetLastError(ERROR_SUCCESS);
  job = CreateJobObjectW(NULL, name);
  if (!job) {
    fail_message("cannot create the job", GetLastError());
    return EXIT_FAILED;
  }
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    /* Someone else made a job with this helper's name: it is not ours. */
    fail_message("a job with this helper's name already exists", ERROR_ALREADY_EXISTS);
    return EXIT_FAILED;
  }
  /* As for the job: an object with this helper's name that it did not make is not its own. */
  helper_object_name(object_name, sizeof object_name / sizeof object_name[0], GetCurrentProcessId(), filetime_value(creation), L"ended");
  SetLastError(ERROR_SUCCESS);
  ended = CreateEventW(NULL, TRUE, FALSE, object_name);
  if (!ended || GetLastError() == ERROR_ALREADY_EXISTS) {
    fail_message("cannot create this helper's ended event", ended ? ERROR_ALREADY_EXISTS : GetLastError());
    return EXIT_FAILED;
  }
  helper_object_name(object_name, sizeof object_name / sizeof object_name[0], GetCurrentProcessId(), filetime_value(creation), L"stopping");
  SetLastError(ERROR_SUCCESS);
  stopping = CreateMutexW(NULL, FALSE, object_name);
  if (!stopping || GetLastError() == ERROR_ALREADY_EXISTS) {
    fail_message("cannot create this helper's stopping mutex", stopping ? ERROR_ALREADY_EXISTS : GetLastError());
    return EXIT_FAILED;
  }
  helper_object_name(object_name, sizeof object_name / sizeof object_name[0], GetCurrentProcessId(), filetime_value(creation), L"unkillable");
  SetLastError(ERROR_SUCCESS);
  unkillable = CreateEventW(NULL, TRUE, FALSE, object_name);
  if (!unkillable || GetLastError() == ERROR_ALREADY_EXISTS) {
    fail_message("cannot create this helper's unkillable event", unkillable ? ERROR_ALREADY_EXISTS : GetLastError());
    return EXIT_FAILED;
  }
  ZeroMemory(&limits, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
    fail_message("cannot set the job's limits", GetLastError());
    return EXIT_FAILED;
  }

  ZeroMemory(&own, sizeof own);
  own.cb = sizeof own;
  GetStartupInfoW(&own);
  ZeroMemory(&startup, sizeof startup);
  startup.cb = sizeof startup;
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  /* The C runtime descriptor table Node passed to this helper (fd 3 and up,
     a Node IPC channel among them) passes on unchanged. */
  startup.cbReserved2 = own.cbReserved2;
  startup.lpReserved2 = own.lpReserved2;
  if (own.dwFlags & STARTF_USESHOWWINDOW) {
    startup.dwFlags |= STARTF_USESHOWWINDOW;
    startup.wShowWindow = own.wShowWindow;
  }
  /* Without a console of its own, a console child would open a visible one. */
  if (!GetConsoleWindow()) flags |= CREATE_NO_WINDOW;

  length = wcslen(command_line);
  mutable_line = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, (length + 1) * sizeof(wchar_t));
  if (!mutable_line) {
    fail_message("out of memory", ERROR_NOT_ENOUGH_MEMORY);
    return EXIT_FAILED;
  }
  memcpy(mutable_line, command_line, (length + 1) * sizeof(wchar_t));
  ZeroMemory(&child, sizeof child);
  if (!CreateProcessW(application, mutable_line, NULL, NULL, TRUE, flags, NULL, NULL, &startup, &child)) {
    DWORD error = GetLastError();
    fail_message("cannot start the program", error);
    return EXIT_NOT_STARTED;
  }
  if (!AssignProcessToJobObject(job, child.hProcess)) {
    DWORD error = GetLastError();
    TerminateProcess(child.hProcess, EXIT_FAILED);
    fail_message("cannot put the program in the job", error);
    return EXIT_FAILED;
  }
  /* After CreateProcess: the child keeps the normal Ctrl+C handling. */
  SetConsoleCtrlHandler(NULL, TRUE);
  if (ResumeThread(child.hThread) == (DWORD)-1) {
    DWORD error = GetLastError();
    TerminateJobObject(job, EXIT_FAILED);
    fail_message("cannot resume the program", error);
    return EXIT_FAILED;
  }
  CloseHandle(child.hThread);
  /* Until the child exits, or a kill ended the job: a child that termination
     cannot finish never exits, and the bounded wait below must still run. */
  waits[0] = child.hProcess;
  waits[1] = ended;
  WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  /* What the child left behind ends with it, and the helper exits with the
     child's code only once the child and every process the job held have
     exited: that exit means the whole tree is gone. Termination is
     asynchronous (a process can wait on pending I/O), so this waits on
     process handles, for at most wait_ms: a process still there then is
     unkillable, and the helper says so instead of waiting forever. After a
     kill, it first waits for that kill to finish its own wait (stop_job),
     and reports what the kill found. */
  deadline = GetTickCount64() + wait_ms;
  if (!stop_job(job, stopping, unkillable, NULL, child.hProcess, deadline, &stop_error)) {
    if (stop_error) fail_message("cannot end what the program left running", stop_error);
    fail_message("the program's job still holds processes after it was ended (unkillable)", ERROR_TIMEOUT);
    return (int)EXIT_SPAWN_UNKILLABLE;
  }
  /* The child has exited, so its code is final. */
  if (!GetExitCodeProcess(child.hProcess, &exit_code)) exit_code = 1;
  return (int)exit_code;
}

static int open_identified_process(DWORD pid, u64 creation, DWORD access, HANDLE *process) {
  FILETIME created, exit_time, kernel, user;
  HANDLE handle = OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!handle) {
    DWORD error = GetLastError();
    if (error == ERROR_INVALID_PARAMETER) return EXIT_ABSENT;
    if (error == ERROR_ACCESS_DENIED) return EXIT_DENIED;
    fail_message("cannot open the process", error);
    return EXIT_FAILED;
  }
  if (!GetProcessTimes(handle, &created, &exit_time, &kernel, &user)) {
    DWORD error = GetLastError();
    CloseHandle(handle);
    fail_message("cannot read the process's creation time", error);
    return EXIT_FAILED;
  }
  if (filetime_value(created) != creation) {
    /* The pid now names another process: never touch it. */
    CloseHandle(handle);
    return EXIT_ABSENT;
  }
  *process = handle;
  return 0;
}

static int run_kill(DWORD pid, u64 creation, DWORD wait_ms) {
  wchar_t name[96], object_name[128];
  HANDLE job, ended, stopping, unkillable, process = NULL;
  int result;
  /* Hold the exact process first: nothing is ended unless <pid> still has that
     creation time, and while the handle is held the pid cannot be reused. */
  result = open_identified_process(pid, creation, PROCESS_TERMINATE | SYNCHRONIZE, &process);
  if (result != 0) return result;
  if (WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
    CloseHandle(process);
    return EXIT_ABSENT;
  }
  job_name(name, sizeof name / sizeof name[0], pid, creation);
  job = OpenJobObjectW(JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY | JOB_OBJECT_SET_ATTRIBUTES, FALSE, name);
  /* Without the right to close it to new processes, the job can still be
     ended; its processes are then not provably all held (unkillable at worst). */
  if (!job && GetLastError() == ERROR_ACCESS_DENIED) job = OpenJobObjectW(JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY, FALSE, name);
  /* A running helper holds the job it created under this name (spawn refuses
     a name that already exists), so while it runs the name is its job. It is
     checked again after the open: had the helper exited in between, its job
     could be gone and the name someone else's. */
  if (job && WaitForSingleObject(process, 0) == WAIT_TIMEOUT) {
    ULONGLONG deadline = GetTickCount64() + wait_ms;
    DWORD helper_code = 0, error = 0;
    int proved;
    helper_object_name(object_name, sizeof object_name / sizeof object_name[0], pid, creation, L"ended");
    ended = OpenEventW(EVENT_MODIFY_STATE, FALSE, object_name);
    helper_object_name(object_name, sizeof object_name / sizeof object_name[0], pid, creation, L"stopping");
    stopping = OpenMutexW(SYNCHRONIZE, FALSE, object_name);
    helper_object_name(object_name, sizeof object_name / sizeof object_name[0], pid, creation, L"unkillable");
    unkillable = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, object_name);
    /* Ends the job, tells the helper (the "ended" event), and waits, within
       the bound, for what the job held; it releases the stopping mutex
       before the wait for the helper below, which needs it. */
    proved = stop_job(job, stopping, unkillable, ended, NULL, deadline, &error);
    if (ended) CloseHandle(ended);
    if (stopping) CloseHandle(stopping);
    if (unkillable) CloseHandle(unkillable);
    CloseHandle(job);
    if (error) {
      CloseHandle(process);
      fail_message("cannot end the job", error);
      return error == ERROR_ACCESS_DENIED ? EXIT_DENIED : EXIT_FAILED;
    }
    result = proved ? 0 : EXIT_UNKILLABLE;
    /* The helper, too, within the bound: one still waiting, or reporting its
       own wait ran out, may be waiting on a process it held before this kill
       (it was already ending its job), which this kill's list cannot see. */
    if (WaitForSingleObject(process, remaining_ms(deadline)) != WAIT_OBJECT_0
        || !GetExitCodeProcess(process, &helper_code) || helper_code == EXIT_SPAWN_UNKILLABLE) {
      result = EXIT_UNKILLABLE;
    }
    CloseHandle(process);
    return result;
  }
  if (job) {
    /* The helper exited between the checks: its tree ended with its job. */
    CloseHandle(job);
    CloseHandle(process);
    return EXIT_ABSENT;
  }
  /* No job: the pid was not started by this helper. End only that exact
     process, through the handle that proved its creation time. */
  if (!TerminateProcess(process, 1)) {
    DWORD error = GetLastError();
    CloseHandle(process);
    fail_message("cannot end the process", error);
    return error == ERROR_ACCESS_DENIED ? EXIT_DENIED : EXIT_FAILED;
  }
  result = WaitForSingleObject(process, wait_ms) == WAIT_OBJECT_0 ? EXIT_SINGLE_PROCESS : EXIT_UNKILLABLE;
  CloseHandle(process);
  return result;
}

static int run_query(DWORD pid, u64 creation) {
  wchar_t name[96];
  char line[32];
  HANDLE job;
  DWORD active;
  job_name(name, sizeof name / sizeof name[0], pid, creation);
  job = OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, name);
  if (!job) {
    DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND) return EXIT_ABSENT;
    if (error == ERROR_ACCESS_DENIED) return EXIT_DENIED;
    fail_message("cannot open the job", error);
    return EXIT_FAILED;
  }
  active = job_active_processes(job);
  CloseHandle(job);
  if (active == (DWORD)-1) {
    fail_message("cannot query the job", GetLastError());
    return EXIT_FAILED;
  }
  _snprintf_s(line, sizeof line, _TRUNCATE, "%lu\n", (unsigned long)active);
  write_text(GetStdHandle(STD_OUTPUT_HANDLE), line);
  return 0;
}

/* Append UTF-16 text to a JSON string body as escaped UTF-8. */
static void append_json_text(char *out, size_t size, const wchar_t *text) {
  int bytes = WideCharToMultiByte(CP_UTF8, 0, text, -1, NULL, 0, NULL, NULL);
  char *utf8;
  size_t used = strlen(out);
  int index;
  if (bytes <= 0) return;
  utf8 = (char *)HeapAlloc(GetProcessHeap(), 0, (size_t)bytes);
  if (!utf8) return;
  WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, bytes, NULL, NULL);
  for (index = 0; utf8[index] && used + 7 < size; index++) {
    unsigned char ch = (unsigned char)utf8[index];
    if (ch == '"' || ch == '\\') { out[used++] = '\\'; out[used++] = (char)ch; }
    else if (ch < 0x20) used += (size_t)_snprintf_s(out + used, size - used, _TRUNCATE, "\\u%04x", ch);
    else out[used++] = (char)ch;
  }
  out[used] = 0;
  HeapFree(GetProcessHeap(), 0, utf8);
}

static int parent_pid(DWORD pid, DWORD *parent) {
  PROCESSENTRY32W entry;
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  int found = 0;
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  entry.dwSize = sizeof entry;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == pid) { *parent = entry.th32ParentProcessID; found = 1; break; }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return found;
}

typedef struct {
  USHORT Length;
  USHORT MaximumLength;
  PWSTR Buffer;
} counted_text;
typedef LONG (WINAPI *query_process_fn)(HANDLE, ULONG, PVOID, ULONG, PULONG);
#define PROCESS_COMMAND_LINE_INFORMATION 60

/* The process's command line (Windows 8.1 and later), or NULL. Free with HeapFree. */
static wchar_t *command_line_of(HANDLE process) {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  query_process_fn query;
  ULONG size = 0;
  BYTE *buffer;
  wchar_t *text;
  counted_text *line;
  if (!ntdll) return NULL;
  query = (query_process_fn)(void *)GetProcAddress(ntdll, "NtQueryInformationProcess");
  if (!query) return NULL;
  query(process, PROCESS_COMMAND_LINE_INFORMATION, NULL, 0, &size);
  if (size < sizeof(counted_text) || size > (1u << 20)) return NULL;
  buffer = (BYTE *)HeapAlloc(GetProcessHeap(), 0, size);
  if (!buffer) return NULL;
  if (query(process, PROCESS_COMMAND_LINE_INFORMATION, buffer, size, &size) < 0) {
    HeapFree(GetProcessHeap(), 0, buffer);
    return NULL;
  }
  line = (counted_text *)buffer;
  text = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, (size_t)line->Length + sizeof(wchar_t));
  if (text) {
    memcpy(text, line->Buffer, line->Length);
    text[line->Length / sizeof(wchar_t)] = 0;
  }
  HeapFree(GetProcessHeap(), 0, buffer);
  return text;
}

static int run_info(DWORD pid) {
  FILETIME created, exit_time, kernel, user;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  int can_wait = 1, exited = 0, has_parent;
  DWORD parent = 0, status = 0, image_length = 32768;
  wchar_t *image, *command_line;
  static char out[2 * 6 * 32768 + 512];
  if (!process) {
    DWORD error = GetLastError();
    if (error == ERROR_INVALID_PARAMETER) return EXIT_ABSENT;
    can_wait = 0;
    process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) {
      error = GetLastError();
      if (error == ERROR_INVALID_PARAMETER) return EXIT_ABSENT;
      if (error == ERROR_ACCESS_DENIED) return EXIT_DENIED;
      fail_message("cannot open the process", error);
      return EXIT_FAILED;
    }
  }
  if (!GetProcessTimes(process, &created, &exit_time, &kernel, &user)) {
    DWORD error = GetLastError();
    CloseHandle(process);
    fail_message("cannot read the process's creation time", error);
    return EXIT_FAILED;
  }
  if (can_wait) exited = WaitForSingleObject(process, 0) == WAIT_OBJECT_0;
  else exited = GetExitCodeProcess(process, &status) && status != STILL_ACTIVE;
  has_parent = parent_pid(pid, &parent);
  _snprintf_s(out, sizeof out, _TRUNCATE, "{\"pid\":%lu,\"parentPid\":", (unsigned long)pid);
  if (has_parent) _snprintf_s(out + strlen(out), sizeof out - strlen(out), _TRUNCATE, "%lu", (unsigned long)parent);
  else strcat_s(out, sizeof out, "null");
  _snprintf_s(out + strlen(out), sizeof out - strlen(out), _TRUNCATE,
    ",\"creationTime\":\"%llu\",\"exited\":%s,\"image\":", filetime_value(created), exited ? "true" : "false");
  image = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, image_length * sizeof(wchar_t));
  if (image && QueryFullProcessImageNameW(process, 0, image, &image_length)) {
    strcat_s(out, sizeof out, "\"");
    append_json_text(out, sizeof out - 4, image);
    strcat_s(out, sizeof out, "\"");
  } else {
    strcat_s(out, sizeof out, "null");
  }
  if (image) HeapFree(GetProcessHeap(), 0, image);
  strcat_s(out, sizeof out, ",\"commandLine\":");
  command_line = command_line_of(process);
  if (command_line) {
    strcat_s(out, sizeof out, "\"");
    append_json_text(out, sizeof out - 4, command_line);
    strcat_s(out, sizeof out, "\"");
    HeapFree(GetProcessHeap(), 0, command_line);
  } else {
    strcat_s(out, sizeof out, "null");
  }
  strcat_s(out, sizeof out, "}\n");
  CloseHandle(process);
  write_text(GetStdHandle(STD_OUTPUT_HANDLE), out);
  return 0;
}

static int parse_identity(int argc, wchar_t **argv, DWORD *pid, u64 *creation) {
  u64 value = 0;
  if (argc < 4 || !parse_decimal(argv[2], 0xffffffffULL, &value) || value == 0) return 0;
  *pid = (DWORD)value;
  return parse_decimal(argv[3], 0xffffffffffffffffULL, creation) && *creation != 0;
}

/* The optional <wait-ms> at argv[index]: absent is DRAIN_MS; 0 to MAX_DRAIN_MS. */
static int parse_wait(int argc, wchar_t **argv, int index, DWORD *wait_ms) {
  u64 value = DRAIN_MS;
  if (argc > index + 1) return 0;
  if (argc == index + 1 && !parse_decimal(argv[index], MAX_DRAIN_MS, &value)) return 0;
  *wait_ms = (DWORD)value;
  return 1;
}

int wmain(int argc, wchar_t **argv) {
  DWORD pid = 0, wait_ms = DRAIN_MS;
  u64 creation = 0, value = 0;
  if (argc < 2) return EXIT_USAGE;
  if (wcscmp(argv[1], L"spawn") == 0) {
    if (argc < 4 || !parse_wait(argc, argv, 4, &wait_ms)) return EXIT_USAGE;
    return run_spawn(argv[2], argv[3], wait_ms);
  }
  if (wcscmp(argv[1], L"kill") == 0) {
    if (!parse_identity(argc, argv, &pid, &creation) || !parse_wait(argc, argv, 4, &wait_ms)) return EXIT_USAGE;
    return run_kill(pid, creation, wait_ms);
  }
  if (wcscmp(argv[1], L"query") == 0) {
    if (argc != 4 || !parse_identity(argc, argv, &pid, &creation)) return EXIT_USAGE;
    return run_query(pid, creation);
  }
  if (wcscmp(argv[1], L"info") == 0) {
    if (argc != 3 || !parse_decimal(argv[2], 0xffffffffULL, &value) || value == 0) return EXIT_USAGE;
    return run_info((DWORD)value);
  }
  return EXIT_USAGE;
}
