/**
 * Per 15 minutes: 10 attempts per visitor address and 200 in all; successful sign-ins are given back.
 * The address is the one the web server wrote, so visitors cannot reset their budget by naming another.
 * A refused attempt counts nowhere: one visitor alone cannot use up everyone's budget.
 */
export class LoginLimits {
  private readonly clients = new Map<string, number>();
  private until = 0;
  private total = 0;

  allow(address: string, now = Date.now()): boolean {
    if (now >= this.until) {
      this.until = now + 15 * 60_000;
      this.total = 0;
      this.clients.clear();
    }
    const count = this.clients.get(address) ?? 0;
    if (count >= 10 || this.total >= 200) return false;
    // At most 200 map entries per window, however many addresses are seen.
    this.clients.set(address, count + 1);
    this.total++;
    return true;
  }

  forgive(address: string): void {
    const count = this.clients.get(address);
    if (!count) return;
    this.clients.set(address, count - 1);
    this.total = Math.max(0, this.total - 1);
  }
}
