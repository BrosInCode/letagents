# Supervised room-agent effects

Supervised room turns expose product actions through the daemon's durable effect journal. The journal is keyed by the exact agent, execution generation, provider turn, and MCP request. A repeated request returns its recorded result instead of running the product action twice.

## Fail-closed completion

If an action succeeds but the daemon cannot durably record its completion, the effect remains `executing`. LetAgents does not repeat it automatically because doing so could duplicate a message, task mutation, artifact, or membership change. This is an intentional fail-closed choice.

There is not yet an operator action for resolving an indefinitely `executing` effect. Until that recovery surface exists, the effect remains blocked with its evidence preserved for diagnosis.

## Room-move acknowledgement

`join_room` prepares a move during the bounded model turn. The daemon first publishes the activating response, then performs the external join and commits the local membership transition. If the destination join fails, the effect is recorded as failed and the agent remains in its original room.

The model can therefore receive `ROOM_MOVE_PREPARED` before the move ultimately fails. Activity and diagnostics retain the failure, but the room does not yet receive a separate automatic notice. A future operator/user-facing recovery surface should expose retry or cancellation explicitly rather than silently repeating the membership effect.
