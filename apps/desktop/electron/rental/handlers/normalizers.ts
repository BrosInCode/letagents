import type {
  DesktopRentalListingInput,
  DesktopRentalListingPatch,
  DesktopRentalManualDeclareInput,
  DesktopRentalStartInput,
} from "../../ipc-types.js";

export function normalizeListingInput(input: unknown): Partial<DesktopRentalListingInput> {
  return input && typeof input === "object" ? input as Partial<DesktopRentalListingInput> : {};
}

export function normalizeListingPatch(input: unknown): Partial<DesktopRentalListingPatch> {
  return input && typeof input === "object" ? input as Partial<DesktopRentalListingPatch> : {};
}

export function normalizeStartInput(input: unknown): Partial<DesktopRentalStartInput> {
  return input && typeof input === "object" ? input as Partial<DesktopRentalStartInput> : {};
}

export function normalizeManualDeclareInput(input: unknown): DesktopRentalManualDeclareInput {
  return input && typeof input === "object" ? input as DesktopRentalManualDeclareInput : {};
}
