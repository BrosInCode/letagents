import { defineComponent, h, type PropType } from "vue";
import type { LaunchJourneyView } from "../../../../domain/launch-journey";
import styles from "./AddAgentSupervisedLaunchActions.module.css";

/**
 * The launch-card action island is a render component so its mutually
 * exclusive branches and native click listeners can be mounted without a
 * browser. Eligibility is computed by the launch controller and passed in as
 * one shared fact; this component never reconstructs it from display state.
 */
export const AddAgentSupervisedLaunchActions = defineComponent({
  name: "AddAgentSupervisedLaunchActions",
  props: {
    progress: {
      type: Object as PropType<LaunchJourneyView>,
      required: true,
    },
    canAddAnotherSupervisedAgent: {
      type: Boolean,
      required: true,
    },
    providerName: {
      type: String,
      required: true,
    },
    hasStopAction: {
      type: Boolean,
      required: true,
    },
    stopping: {
      type: Boolean,
      required: true,
    },
  },
  emits: {
    "add-another": () => true,
    stop: () => true,
    dismiss: () => true,
  },
  setup(props, { emit }) {
    return () => h("div", { class: styles.actions }, [
      props.canAddAnotherSupervisedAgent
        ? h("button", {
            type: "button",
            class: styles.button,
            "data-testid": "desktop-add-agent-add-another-supervised",
            onClick: () => emit("add-another"),
          }, `Add another ${props.providerName} agent`)
        : props.hasStopAction
          ? h("button", {
              type: "button",
              class: [styles.button, styles.danger],
              "data-testid": "desktop-add-agent-stop-supervised-runtime",
              disabled: props.stopping,
              onClick: () => emit("stop"),
            }, props.stopping
              ? "Stopping..."
              : props.progress.stopFailed
                ? "Retry stop"
                : props.progress.ready
                  ? "Stop this supervised agent"
                  : "Cancel launch")
          : props.progress.failed || props.progress.stopped
            ? h("button", {
                type: "button",
                class: styles.button,
                "data-testid": "desktop-add-agent-dismiss-launch",
                onClick: () => emit("dismiss"),
              }, "Dismiss")
            : null,
    ]);
  },
});
