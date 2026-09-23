// Who may write to the terminal while the agent runs.
//
// Claude Code's interactive UI owns the terminal: it redraws the screen on
// every keystroke and every streamed token. A line Vantage writes to the same
// terminal lands wherever the cursor happens to be — over the input box, in
// the middle of a reply — and vanishes at the next redraw. So while that UI is
// open, Vantage keeps the terminal to itself:
//
//   - routine lines (the per-request status) are dropped; `vantage watch`
//     shows the same numbers live in a second terminal;
//   - alerts (quota, budget, policy notices) are held and printed once the
//     agent exits, so none is lost.
//
// In print mode (`claude -p`) there is no redrawing UI, and output goes
// through as it always did.

export class TerminalGate {
  private holding = false;
  private held: string[] = [];
  private readonly write: (text: string) => void;

  constructor(write: (text: string) => void) {
    this.write = write;
  }

  get isHolding(): boolean {
    return this.holding;
  }

  hold(): void {
    this.holding = true;
  }

  /** Stops holding and returns the alerts collected meanwhile, in order. */
  release(): string[] {
    this.holding = false;
    const held = this.held;
    this.held = [];
    return held;
  }

  /** Routine output: shown now, or dropped while the agent owns the terminal. */
  info(text: string): void {
    if (!this.holding) this.write(text);
  }

  /** Something the user must see: shown now, or held until the agent exits. */
  alert(text: string): void {
    if (!this.holding) this.write(text);
    else if (!this.held.includes(text)) this.held.push(text);
  }
}
