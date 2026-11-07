import { useDesktopOrganizations } from "../useDesktopOrganizations";
import type { AppContextOf } from "./context";

/** The optional company the person works in, and the first-run company step. */
export function useAppCompany(context: unknown) {
  const app = context as AppContextOf<"useAppState" | "useAppSetupOnboarding">;
  const company = useDesktopOrganizations(app.authStatus);

  async function chooseOnboardingCompany(id: string | null): Promise<void> {
    if (await company.choose(id)) {
      app.firstRunRoomSelected.value = false;
      app.continueToRoomConfirmation();
    }
  }

  return { company, chooseOnboardingCompany };
}
