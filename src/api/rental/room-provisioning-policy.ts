export function isRentalParticipantProvisionableStatus(status: string): boolean {
  return status === "accepted" || status === "provisioning" || status === "active";
}
