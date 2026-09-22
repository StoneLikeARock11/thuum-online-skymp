import { MsgType } from "../../messages";
import { logError, logTrace } from "../../logging";
import { BrowserMessageEvent } from "skyrimPlatform";
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

/**
 * The payload carried beside the gate word, and the way back.
 *
 * Both are OPAQUE. `VIEW_FIELD` is handed to the page as-is; `PAGE_MESSAGE` arrives from the page
 * as a string and goes on the wire as that same string. This file never reads a key out of either.
 * That is what lets the same two names carry a character list today and something else tomorrow
 * without the client being taught anything about a realm's design.
 */
const VIEW_FIELD = "seatView";
const PAGE_MESSAGE = "thuum-seat";
const PAGE_SHOWN = "thuum-seat-shown";
const PAGE_OBJECT = "window.thuumSeat";

type HeldSeat = {
  event: ConnectionMessage<CreateActorMessage>;
  run: (event: ConnectionMessage<CreateActorMessage>) => void;
};

export class SeatGateService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
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
    // Lifted out of the try beside `word`, because the payload has to outlive the parse. It is
    // carried, never read: see the note on VIEW_FIELD.
    let view: unknown;
    try {
      const content = JSON.parse(event.message.contentJsonDump) as Record<string, unknown>;
      word = content ? content[GATE_FIELD] : undefined;
      view = content ? content[VIEW_FIELD] : undefined;
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
      this.showOnPage(view);
      return;
    }

    if (word === RELEASE) {
      this.holding = false;
      this.hideOnPage();
      this.release("the realm said who");
      return;
    }

    logError(this, `Ignoring an unknown ${GATE_FIELD} value:`, JSON.stringify(word));
  }

  /**
   * Hand the payload to the page. It is re-serialised, not inspected: whatever the realm put there
   * arrives at the page in the same shape it was sent, and nothing in between formed an opinion.
   */
  private showOnPage(view: unknown): void {
    if (view === undefined || view === null) {
      return;
    }
    if (this.askedPageAt === 0) {
      this.askedPageAt = Date.now();
    }
    let json: string;
    try {
      json = JSON.stringify(view);
    } catch (e) {
      logError(this, "A seat payload could not be re-serialised for the page:", e);
      return;
    }
    try {
      this.sp.browser.setVisible(true);
      this.sp.browser.setFocused(true);
      this.sp.browser.executeJavaScript(`${PAGE_OBJECT} && ${PAGE_OBJECT}.show(${json})`);
    } catch (e) {
      // The page may not be up yet. The realm re-sends while it is still holding, so this is not
      // the last chance - but it is worth saying, because a silent failure here is a player looking
      // at a menu with nothing on it.
      logError(this, "Could not put the seat payload on the page:", e);
    }
  }

  private hideOnPage(): void {
    try {
      this.sp.browser.executeJavaScript(`${PAGE_OBJECT} && ${PAGE_OBJECT}.hide()`);
      this.sp.browser.setFocused(false);
    } catch (e) {
      // Nothing to do about it, and the world is about to load over the top anyway.
    }
  }

  /**
   * The way back. The page hands over a string; it goes on the wire as that string.
   *
   * Not parsed, not validated, not re-encoded. The realm is the only thing that understands what
   * is in it, and the realm checks it - `selectCharacter` tests ownership against the server's own
   * list precisely because a page is a thing a player can edit. Validating here would be a second,
   * weaker copy of a check that has to exist there anyway.
   */
  private onBrowserMessage(e: BrowserMessageEvent): void {
    const a = e && e.arguments;

    // THE PAGE SAYING IT DREW. Asking a page to draw and a page having drawn are not the same
    // thing, and the difference is a player sitting at a connect screen forever - which is exactly
    // what happened the first time this was tested, with the bundle installed and the page not.
    if (a && a[0] === PAGE_SHOWN) {
      if (!this.pageAnswered) {
        this.pageAnswered = true;
        logTrace(this, "The page has drawn the choice");
      }
      return;
    }

    if (!a || a[0] !== PAGE_MESSAGE) {
      return;
    }
    const payload = a[1];
    if (typeof payload !== "string") {
      logError(this, `${PAGE_MESSAGE} needs a string payload, got`, typeof payload);
      return;
    }
    logTrace(this, "Passing the page's answer to the realm");
    this.controller.emitter.emit("sendMessage", {
      message: { t: MsgType.CustomPacket, contentJsonDump: payload },
      reliability: "reliable",
    });
  }

  private onTick(): void {
    if (this.held === null || this.heldSince === 0) {
      return;
    }

    // DEADMAN ONE: A PAGE THAT CANNOT ANSWER.
    //
    // Seconds, not minutes. If the realm has sent something to show and the page has not said it
    // drew, there is nothing for the player to click and no amount of waiting will produce one. The
    // commonest cause is the page and this bundle being different versions - they ship by different
    // routes - so the message names that first.
    if (this.askedPageAt !== 0 && !this.pageAnswered
        && Date.now() - this.askedPageAt >= this.pageMustAnswerMs) {
      logError(
        this,
        `The realm sent a character choice but the page never drew it `
        + `(waited ${Math.round(this.pageMustAnswerMs / 1000)}s). Almost certainly this client `
        + `bundle and Data/Platform/UI/index.html are different versions - they ship by different `
        + `routes. Falling through to normal behaviour: you will be seated as whichever character `
        + `the realm picked, which is what happens without this feature at all.`,
      );
      this.holding = false;
      this.askedPageAt = 0;
      this.release("the page never answered");
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
    this.hideOnPage();
    this.release("the hold expired");
  }

  private release(why: string): void {
    const held = this.held;
    this.held = null;
    this.heldSince = 0;
    this.askedPageAt = 0;
    this.pageAnswered = false;
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
  /** When the realm last gave us something to show, and whether the page admitted drawing it. */
  private askedPageAt = 0;
  private pageAnswered = false;
  /** Seconds: a page either draws promptly or is not going to. */
  private readonly pageMustAnswerMs = 6000;
  /** Minutes: a drawn page is waiting on a person, and people are slow. */
  private readonly maxHoldMs = 180000;
}
