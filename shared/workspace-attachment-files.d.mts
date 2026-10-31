/** Open flags for reading an attachment or a copy of one: read only, no symlink, never blocking on a pipe. */
export declare const ATTACHMENT_READ_FLAGS: number;

export declare function attachmentFileName(requested: string): string;

export interface WorkspaceAttachmentFile {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

export interface WorkspaceAttachmentRoots {
  /** The workspace's real path, with no link in it. */
  workspace: string;
  /** Other names of the same folder that an agent may use in absolute paths. */
  aliases?: readonly string[];
  /** What a relative name resolves against; the workspace when omitted. */
  baseDirectory?: string;
}

export declare function readWorkspaceAttachmentFile(
  roots: WorkspaceAttachmentRoots,
  requested: string,
): Promise<WorkspaceAttachmentFile>;

export declare function workspaceAliases(
  workspace: string,
  workingDirectory: string,
  logicalWorkingDirectories: readonly (string | undefined)[],
): Promise<string[]>;

export declare function isFileSystemRoot(path: string): boolean;
