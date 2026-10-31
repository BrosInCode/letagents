/** Folder names that hold credentials or an agent tool's private configuration, wherever they are. */
export declare const CREDENTIAL_FOLDER_NAMES: ReadonlySet<string>;
export declare function executionApprovalProjectionPathsAreSafe(paths: readonly string[]): boolean;
export declare function workspacePathMayHoldCredentials(parts: readonly string[]): boolean;
