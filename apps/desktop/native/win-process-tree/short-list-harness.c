/*
 * Test build only, never shipped or sealed: the unchanged helper source with
 * one Windows call wrapped. A process that has begun to exit is still counted
 * by its job but no longer listed, for about a millisecond, so nothing outside
 * can hold that state. Here the process-id list reads one process short for the
 * first LETAGENTS_TEST_SHORT_READS reads (a negative value: for every read).
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

#define QueryInformationJobObject short_list_query
#include "letagents-process-tree.c"
