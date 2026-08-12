import { z } from "zod";

import type { AppAgentActionDefinition } from "../types.js";

type ActionRegistrar = {
  register: <TInput extends z.ZodTypeAny>(
    action: AppAgentActionDefinition<TInput>,
  ) => unknown;
};

export const settingsGetInputSchema = z.object({});

export const setChatStorageModeInputSchema = z.object({
  mode: z.enum(["cloud", "local"]),
});

export function registerSettingsActions(registry: ActionRegistrar): void {
  registry.register({
      id: "settings.get",
      toolName: "get_app_settings",
      description:
        "Read safe desktop settings that the App Agent may reason about. Never returns API keys or secrets.",
      category: "settings",
      risk: "low",
      requiresConfirmation: false,
      refreshTargets: [],
      inputSchema: settingsGetInputSchema,
      inputSummary: () => "Read settings",
      resultLabel: () => "Read settings",
      confirmation: () => ({
        label: "Read settings",
        description: "Read safe app settings.",
        confirmLabel: "Read",
        cancelLabel: "Cancel",
      }),
      execute: async (_input, context) => {
        const [chatStorage, appAgent] = await Promise.all([
          context.deps.getChatStorageSettings(),
          context.deps.getAppAgentSettingsStatus(),
        ]);
        return {
          message: "Read app settings.",
          actionResult: {
            chatStorage: {
              mode: chatStorage.mode,
              defaultMode: chatStorage.defaultMode,
              savedAt: chatStorage.savedAt,
            },
            appAgent: {
              configured: appAgent.configured,
              model: appAgent.model,
              savedAt: appAgent.savedAt,
              error: appAgent.error,
            },
          },
        };
      },
    });
  registry.register({
      id: "settings.set_chat_storage_mode",
      toolName: "set_chat_storage_mode",
      description:
        "Set the desktop chat storage mode to cloud or local. This changes where new chat messages are stored.",
      category: "settings",
      risk: "medium",
      requiresConfirmation: true,
      refreshTargets: ["settings", "active_room", "foreground"],
      inputSchema: setChatStorageModeInputSchema,
      inputSummary: (input) => `Set chat storage to ${input.mode}`,
      resultLabel: (input) => `Set chat storage to ${input.mode}`,
      confirmation: (input) => ({
        label: `Set chat storage to ${input.mode}`,
        description:
          input.mode === "local"
            ? "Switch chat storage to local? New messages stay on this computer."
            : "Switch chat storage to cloud? New messages use cloud storage.",
        confirmLabel: "Change",
        cancelLabel: "Cancel",
      }),
      execute: async (input, context) => {
        const settings = await context.deps.setChatStorageMode(input.mode);
        return {
          message:
            input.mode === "local"
              ? "Chat storage is now local."
              : "Chat storage is now cloud.",
          actionResult: {
            mode: settings.mode,
            defaultMode: settings.defaultMode,
            savedAt: settings.savedAt,
          },
        };
      },
    });
}
