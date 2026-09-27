export interface DaemonMaintenanceHold { version: 1; id: string; createdAt: string }
export function daemonMaintenancePath(root?: string): string;
export const DAEMON_MAINTENANCE_MESSAGE: string;
export function readDaemonMaintenance(path?: string): Promise<DaemonMaintenanceHold | null>;
export function createDaemonMaintenance(path?: string): Promise<DaemonMaintenanceHold>;
export function clearDaemonMaintenance(id: string, path?: string): Promise<void>;

export interface DaemonMaintenanceOperation {
  read(): Promise<DaemonMaintenanceHold | null>;
  create(): Promise<DaemonMaintenanceHold>;
  clear(id: string): Promise<void>;
}
export function withDaemonMaintenanceOperation<T>(operation: (owner: DaemonMaintenanceOperation) => Promise<T>, path?: string): Promise<T>;
