import { logError, logTrace } from "../../logging";
import { ConnectionMessage } from "../events/connectionMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { ClientListener, CombinedController, Sp } from "./clientListener";

/**
 * THU'UM ONLINE FORK CHANGE. Hold `loadGame` until the realm says who the player is.
 *
 * WHAT STOCK DOES. The server seats a character the moment a connection is accepted - stock spawn
 * takes `getActorsByProfileId(profileId)[0]`, the lowest form id, with no way for a gamemode to opt
 * out: `spawnAllowed` is emitted on an EventEmitter the gamemode cannot reach, and
 * `mp.removeListener` is not exposed. `setUserActor` then sends a `CreateActorMessage` with
 * `isMe`, and RemoteServer calls `loadGame` on the spot. By the time a player could be asked which
 * character they want, they are already standing in the world as one of them.
 *
 * Correcting that afterwards means a second `setUserActor`, which means a second `loadGame`, which
 * means a second loading screen. That is the one thing no amount of gamemode code can fix, and it
 * is the only reason this fork exists.
 *
 * WHAT THIS DOES. While the gate is holding, an `isMe` message is not acted on - it is kept. The
 * player stays at the main menu with the browser page up, which is where character select belongs.
 * When the realm releases the gate, the MOST RECENT held message is the one that runs.
 *
 * That last sentence is the whole trick. Stock spawn still seats `[0]` and still sends its message;
 * it is simply never loaded. The realm then seats the character the player actually chose, and that
 * message is the one that reaches `loadGame`. One loading screen, and it is the right character -
 * without the fork needing any power to stop stock spawn from running.
 *
 * WHAT IT DELIBERATELY DOES NOT KNOW. This file understands exactly one field name and two values.
 * It does not know what a character is, what a slot is, or what the realm allows - all of that stays
 * behind the `mp` API in a private gamemode, which is a separate work and does not move. A client
 * that understood the realm's schema would drag that design into a GPL-3.0 repository, so it is not
 * told. It waits for a signal; it does not understand one.
 *
 * DEFAULT IS STOCK BEHAVIOUR. Nothing holds unless a server asks for it, so this build against an
 * ordinary SkyMP server behaves exactly like an unmodified one.
 *
 * THE DEADMAN. A gate that can only be opened from outside is a way to strand a player at a menu
 * forever - a server that crashes mid-selection, a packet that never arrives, a bug in our own
 * gamemode. So a hold expires: after `maxHoldMs` the held message runs anyway and says loudly why.
 * Being in the world as the wrong character is recoverable; being at a menu that never ends is not.
 * The timer runs on `tick` rather than `update`, because `update` does not fire at the main menu -
 * which is the only place this gate is ever holding.
 */

/** The one field this fork reads out of a server's custom packets. */
const GATE_FIELD = "seatGate";
const HOLD = "hold";
const RELEASE = "release";

type HeldSeat = {
  event: ConnectionMessage<CreateActorMessage>;
  run: (event: ConnectionMessage<CreateActorMessage>) => void;
};

export class SeatGateService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("tick", () => this.onTick());
  }

  /** True while the realm has asked us not to seat anybody yet. */
  public shouldHold(): boolean {
    return this.holding;
  }

  /** True while a seat is actually being kept back - used to keep the browser page up. */
  public isHolding(): boolean {
    return this.holding || this.held !== null;
  }

  /**
   * Keep this seat instead of taking it. A seat held while another is already waiting REPLACES it:
   * the newest word from the realm is the one that counts, which is what makes the stock `[0]`
   * seating harmless rather than something we have to prevent.
   */
  public holdSeat(
    event: ConnectionMessage<CreateActorMessage>,
    run: (event: ConnectionMessage<CreateActorMessage>) => void,
  ): void {
    if (this.held !== null) {
      logTrace(this, "Replacing a held seat with a newer one - the realm has changed its mind");
    }
    this.held = { event, run };
    if (this.heldSince === 0) {
      this.heldSince = Date.now();
    }
    logTrace(this, "Holding a seat at the main menu, waiting for the realm to say who");
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let word: unknown;
    try {
      const content = JSON.parse(event.message.contentJsonDump) as Record<string, unknown>;
      word = content ? content[GATE_FIELD] : undefined;
    } catch (e) {
      // Not ours, or not JSON. Every other packet on this connection comes through here, so this is
      // the ordinary case and must stay silent.
      return;
    }
    if (word === undefined) {
      return;
    }

    if (word === HOLD) {
      if (!this.holding) {
        logTrace(this, "The realm asked us to hold - no character will be seated until it says so");
      }
      this.holding = true;
      return;
    }

    if (word === RELEASE) {
      this.holding = false;
      this.release("the realm said who");
      return;
    }

    logError(this, `Ignoring an unknown ${GATE_FIELD} value:`, JSON.stringify(word));
  }

  private onTick(): void {
    if (this.held === null || this.heldSince === 0) {
      return;
    }
    const heldFor = Date.now() - this.heldSince;
    if (heldFor < this.maxHoldMs) {
      return;
    }
    // Say what went wrong, not just that something did. A player who ends up as the wrong character
    // should be able to find out why from the log rather than guess.
    logError(
      this,
      `The realm held a seat for ${Math.round(heldFor / 1000)}s without releasing it. Seating the `
      + `last character it sent so the player is not stranded at the menu. This is a fault in the `
      + `realm, not in the player's game.`,
    );
    this.holding = false;
    this.release("the hold expired");
  }

  private release(why: string): void {
    const held = this.held;
    this.held = null;
    this.heldSince = 0;
    if (held === null) {
      return;
    }
    logTrace(this, `Releasing the held seat: ${why}`);
    try {
      held.run(held.event);
    } catch (e) {
      // A throw here would leave the player at a menu with nothing coming, which is the one outcome
      // this service exists to prevent. It cannot be swallowed quietly.
      logError(this, "Failed to seat the held character:", e);
    }
  }

  private holding = false;
  private held: HeldSeat | null = null;
  private heldSince = 0;
  private readonly maxHoldMs = 180000;
}
