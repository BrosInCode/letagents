export interface RentalToolDeps {
  apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T>;
}
