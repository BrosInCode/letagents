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
 *       directory and environment. When the child exits, or when a `kill`
 *       ends the job (it signals this helper's "ended" event), the rest of
 *       the job is ended and this helper exits with the child's exit code
 *       once the job is empty. If the job still holds processes <wait-ms>
 *       (default 5000) after that, even the child itself, they are reported
 *       unkillable: this helper exits with 0xE04C5401 instead of the child's
 *       code. If this helper is killed, its job handle closes and Windows
 *       ends the job. Exit 120:
 *       usage; 121: job setup failed; 122: the child could not be started
 *       (the reason is on stderr).
 *
 *   kill <pid> <creation-time> [<wait-ms>]
 *       Only if process <pid> has that creation time (checked while a handle
 *       to it is held, so the pid cannot be reused in between): end its job
 *       when it is a running helper, else end that one process. Exit 0: job ended and empty;
 *       5: the single process was ended (it had no job); 2: nothing with that
 *       identity exists, nothing was ended; 3: access denied; 4: unkillable,
 *       the job (or the process) was ended but processes remained <wait-ms>
 *       (default 5000) later; 120: usage; 121: error.
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

/* The event a kill signals once it has ended that helper's job, so the
   helper bounds its wait even while its own child has not exited. */
static void ended_event_name(wchar_t *name, size_t size, DWORD pid, u64 creation) {
  _snwprintf_s(name, size, _TRUNCATE, L"Local\\letagents-process-tree-%lu-%llu-ended", (unsigned long)pid, creation);
}

static DWORD job_active_processes(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  ZeroMemory(&accounting, sizeof accounting);
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, NULL)) return (DWORD)-1;
  return accounting.ActiveProcesses;
}

/* Wait until the job is empty. The port, when given, wakes the wait early. */
static int drain_job(HANDLE job, HANDLE port, DWORD timeout_ms) {
  ULONGLONG deadline = GetTickCount64() + timeout_ms;
  for (;;) {
    DWORD active = job_active_processes(job);
    ULONGLONG now = GetTickCount64();
    DWORD slice;
    if (active == 0) return 1;
    if (now >= deadline) return 0;
    slice = (DWORD)(deadline - now);
    if (slice > 50) slice = 50;
    if (port) {
      DWORD message = 0;
      ULONG_PTR key = 0;
      LPOVERLAPPED overlapped = NULL;
      GetQueuedCompletionStatus(port, &message, &key, &overlapped, slice);
    } else {
      Sleep(slice);
    }
  }
}

static int run_spawn(const wchar_t *application, const wchar_t *command_line, DWORD wait_ms) {
  FILETIME creation, exit_time, kernel, user;
  wchar_t name[96], event_name[112];
  HANDLE job, port, ended, waits[2];
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association;
  STARTUPINFOW own, startup;
  PROCESS_INFORMATION child;
  DWORD flags = CREATE_SUSPENDED;
  DWORD exit_code = 1;
  int reported = 0;
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
  ended_event_name(event_name, sizeof event_name / sizeof event_name[0], GetCurrentProcessId(), filetime_value(creation));
  SetLastError(ERROR_SUCCESS);
  ended = CreateEventW(NULL, TRUE, FALSE, event_name);
  if (!ended || GetLastError() == ERROR_ALREADY_EXISTS) {
    /* As for the job: an event with this helper's name that it did not make is not its own. */
    fail_message("cannot create this helper's ended event", ended ? ERROR_ALREADY_EXISTS : GetLastError());
    return EXIT_FAILED;
  }
  ZeroMemory(&limits, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
    fail_message("cannot set the job's limits", GetLastError());
    return EXIT_FAILED;
  }
  port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (port) {
    association.CompletionKey = (PVOID)job;
    association.CompletionPort = port;
    if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &association, sizeof association)) {
      CloseHandle(port);
      port = NULL;
    }
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
     child's code only once the job is empty: that exit means the whole tree
     is gone. Termination is asynchronous (a process can wait on pending
     I/O), so it is repeated, for at most wait_ms: a process still there
     then is unkillable, and the helper says so instead of waiting forever. */
  deadline = GetTickCount64() + wait_ms;
  for (;;) {
    ULONGLONG now;
    DWORD slice;
    if (!TerminateJobObject(job, 1) && !reported) {
      fail_message("cannot end what the program left running; waiting for it", GetLastError());
      reported = 1;
    }
    now = GetTickCount64();
    slice = now >= deadline ? 0 : (deadline - now > 1000 ? 1000 : (DWORD)(deadline - now));
    if (drain_job(job, port, slice)) break;
    if (GetTickCount64() >= deadline) {
      fail_message("the program's job still holds processes after it was ended (unkillable)", ERROR_TIMEOUT);
      return (int)EXIT_SPAWN_UNKILLABLE;
    }
  }
  /* The job is empty, so the child (in it) has exited and its code is final. */
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
  wchar_t name[96], event_name[112];
  HANDLE job, ended, process = NULL;
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
  job = OpenJobObjectW(JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY, FALSE, name);
  /* A running helper holds the job it created under this name (spawn refuses
     a name that already exists), so while it runs the name is its job. It is
     checked again after the open: had the helper exited in between, its job
     could be gone and the name someone else's. */
  if (job && WaitForSingleObject(process, 0) == WAIT_TIMEOUT) {
    if (!TerminateJobObject(job, 1)) {
      DWORD error = GetLastError();
      CloseHandle(job);
      CloseHandle(process);
      fail_message("cannot end the job", error);
      return error == ERROR_ACCESS_DENIED ? EXIT_DENIED : EXIT_FAILED;
    }
    /* Tell the helper its job was ended, so its own wait is bounded too. */
    ended_event_name(event_name, sizeof event_name / sizeof event_name[0], pid, creation);
    ended = OpenEventW(EVENT_MODIFY_STATE, FALSE, event_name);
    if (ended) {
      SetEvent(ended);
      CloseHandle(ended);
    }
    /* Bounded: processes still in the job after wait_ms are unkillable. */
    result = drain_job(job, NULL, wait_ms) ? 0 : EXIT_UNKILLABLE;
    CloseHandle(job);
    /* The helper exits once its program has: a short wait, so this command
       stays well inside its caller's timeout. */
    WaitForSingleObject(process, 1000);
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
