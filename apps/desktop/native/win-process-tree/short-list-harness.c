/*
 * Test build only, never shipped or sealed: the unchanged helper source with
 * two Windows calls wrapped.
 *
 * A process that has begun to exit is still counted by its job but no longer
 * listed, for about a millisecond, so nothing outside can hold that state.
 * Here the process-id list reads one process short for the first
 * LETAGENTS_TEST_SHORT_READS reads (a negative value: for every read).
 *
 * The system process list that `births` reads cannot be made malformed from
 * outside either. With LETAGENTS_TEST_SNAPSHOT set, `births` gets a stand-in
 * NtQuerySystemInformation that writes a known list (pid 1000 created at 5,
 * pid 2000 listed with no creation time, pid 3000 created at 7, and this
 * helper with its real creation time, the anchor `births` requires) or a
 * broken one, named by the variable's value.
 */
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static BOOL WINAPI short_list_query(HANDLE job, JOBOBJECTINFOCLASS information, LPVOID buffer, DWORD size, LPDWORD returned) {
  static int configured = 0;
  static long reads_left = 0;
  BOOL ok = QueryInformationJobObject(job, information, buffer, size, returned);
  if (!configured) {
    wchar_t value[16];
    configured = 1;
    if (GetEnvironmentVariableW(L"LETAGENTS_TEST_SHORT_READS", value, 16)) reads_left = _wtol(value);
  }
  if (ok && information == JobObjectBasicProcessIdList && reads_left != 0) {
    JOBOBJECT_BASIC_PROCESS_ID_LIST *list = (JOBOBJECT_BASIC_PROCESS_ID_LIST *)buffer;
    list->NumberOfAssignedProcesses = list->NumberOfProcessIdsInList + 1;
    if (reads_left > 0) reads_left--;
  }
  return ok;
}

#define FAKE_ENTRY 96

/* The fields `births` reads, at the 64-bit SYSTEM_PROCESS_INFORMATION offsets. */
static void fake_entry(BYTE *base, ULONG at, ULONG next, LONGLONG created, unsigned long long id) {
  memcpy(base + at, &next, sizeof next);
  memcpy(base + at + 32, &created, sizeof created);
  memcpy(base + at + 80, &id, sizeof id);
}

static LONG WINAPI fake_query_system(ULONG information, PVOID out, ULONG size, PULONG returned) {
  static int calls = 0;
  wchar_t mode[32];
  BYTE *base = (BYTE *)out;
  ULONG used = 4 * FAKE_ENTRY;
  FILETIME created, exit_time, kernel, user;
  LONGLONG self_time = 0;
  (void)information;
  if (GetProcessTimes(GetCurrentProcess(), &created, &exit_time, &kernel, &user)) {
    self_time = (LONGLONG)(((unsigned long long)created.dwHighDateTime << 32) | created.dwLowDateTime);
  }
  calls++;
  mode[0] = 0;
  GetEnvironmentVariableW(L"LETAGENTS_TEST_SNAPSHOT", mode, 32);
  if (wcscmp(mode, L"status-error") == 0) return (LONG)0xC0000022L;
  if (wcscmp(mode, L"always-mismatch") == 0) { *returned = size + 8; return (LONG)0xC0000004L; }
  if (wcscmp(mode, L"too-large") == 0) { *returned = 0xFFFFFFF0u; return (LONG)0xC0000004L; }
  if (wcscmp(mode, L"mismatch-then-valid") == 0 && calls == 1) { *returned = size * 2; return (LONG)0xC0000004L; }
  if (size < 5 * FAKE_ENTRY) { *returned = 5 * FAKE_ENTRY; return (LONG)0xC0000004L; }
  ZeroMemory(base, 5 * FAKE_ENTRY);
  fake_entry(base, 0, FAKE_ENTRY, 5, 1000);
  fake_entry(base, FAKE_ENTRY, FAKE_ENTRY, 0, 2000);
  fake_entry(base, 2 * FAKE_ENTRY, FAKE_ENTRY, 7, 3000);
  fake_entry(base, 3 * FAKE_ENTRY, 0, self_time, GetCurrentProcessId());
  if (wcscmp(mode, L"truncated") == 0) used = 60;
  else if (wcscmp(mode, L"entry-cut") == 0) used = 3 * FAKE_ENTRY + 40;
  else if (wcscmp(mode, L"self-missing") == 0) { fake_entry(base, 2 * FAKE_ENTRY, 0, 7, 3000); used = 3 * FAKE_ENTRY; }
  else if (wcscmp(mode, L"self-wrong-time") == 0) fake_entry(base, 3 * FAKE_ENTRY, 0, self_time + 1, GetCurrentProcessId());
  else if (wcscmp(mode, L"self-twice") == 0) fake_entry(base, 0, FAKE_ENTRY, self_time, GetCurrentProcessId());
  else if (wcscmp(mode, L"over-length") == 0) used = size + 1;
  else if (wcscmp(mode, L"next-outside") == 0) fake_entry(base, 0, 4096, 5, 1000);
  else if (wcscmp(mode, L"next-short") == 0) fake_entry(base, 0, 16, 5, 1000);
  else if (wcscmp(mode, L"next-misaligned") == 0) fake_entry(base, 0, FAKE_ENTRY + 4, 5, 1000);
  else if (wcscmp(mode, L"wide-pid") == 0) fake_entry(base, 0, FAKE_ENTRY, 5, 0x100000000ULL + 1000);
  else if (wcscmp(mode, L"duplicate") == 0) fake_entry(base, FAKE_ENTRY, FAKE_ENTRY, 9, 1000);
  else if (wcscmp(mode, L"negative-time") == 0) fake_entry(base, 0, FAKE_ENTRY, -5, 1000);
  *returned = used;
  return 0;
}

static FARPROC WINAPI snapshot_proc_address(HMODULE module, LPCSTR name) {
  wchar_t mode[32];
  if (lstrcmpA(name, "NtQuerySystemInformation") == 0 && GetEnvironmentVariableW(L"LETAGENTS_TEST_SNAPSHOT", mode, 32)) {
    return (FARPROC)(void *)fake_query_system;
  }
  return GetProcAddress(module, name);
}

#define QueryInformationJobObject short_list_query
#define GetProcAddress snapshot_proc_address
#include "letagents-process-tree.c"
