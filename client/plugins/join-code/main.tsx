// Two surfaces:
//  - background (presenter's device): owns the "showing" state and the
//    "toggle" command (the bottom-bar button, the C key), and broadcasts the
//    state to viewers (retained, so a phone that joins while the code is up
//    shows it too);
//  - viewer (every viewer screen): draws a QR code for the join link and the
//    code while it's showing.

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { mount, usePresio } from "../sdk/react";
// Built for telling characters apart (B/8, S/5, Z/2), and bundled so a
// projector never falls back to whatever monospace it happens to have.
// Latin bold is all the code needs.
import "@fontsource/atkinson-hyperlegible-mono/latin-700.css";
import "./join-code.css";

function Background() {
  const { session } = usePresio();
  const [showing, setShowing] = useState(false);
  const showingRef = useRef(false);

  useEffect(
    () =>
      presio.commands.register("toggle", () => {
        // A local deck has no join code to show.
        if (presio.session.local) return;
        showingRef.current = !showingRef.current;
        presio.messages.send("visible", { on: showingRef.current }, { retain: true });
        setShowing(showingRef.current);
      }),
    []
  );

  useEffect(() => {
    presio.ui.setButton("toggle", {
      active: showing && !session.local,
      // A local deck has no join code to show.
      disabled: session.local,
      label: showing && !session.local ? "Hide join code" : "Join code",
    });
  }, [showing, session.local]);

  return null;
}

function Viewer() {
  const { session, settings } = usePresio();
  const [showing, setShowing] = useState(false);

  useEffect(
    () =>
      presio.messages.onMessage(({ type, payload, from }) => {
        if (type === "visible" && from === "presenter") setShowing(!!(payload as { on?: boolean } | undefined)?.on);
      }),
    []
  );

  const visible = showing && !session.local;
  useEffect(() => presio.ui.setVisible(visible), [visible]);

  const { joinUrl } = session;
  return (
    <div className="stage">
      <div className="heading">{String(settings.get("heading") ?? "")}</div>
      {joinUrl && settings.get("showQr") !== false && (
        <div className="qr">
          <QRCodeSVG value={joinUrl} size={512} />
        </div>
      )}
      <div className="code">{session.id}</div>
      {joinUrl && settings.get("showUrl") !== false && (
        <div className="url">{joinUrl.replace(/^https?:\/\//, "")}</div>
      )}
    </div>
  );
}

mount(presio.surface === "viewer" ? <Viewer /> : <Background />);
