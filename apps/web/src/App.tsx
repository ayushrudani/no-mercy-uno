/**
 * Screen routing. There are only four states, so a switch beats a router:
 * signed out -> lobby -> waiting room -> table.
 */

import { useEffect, useState } from 'react';
import { api, tokenStore, type Profile } from './lib/api.js';
import { useNetworkAlerts, useStore } from './lib/store.js';
import { sound } from './lib/sound.js';
import { ReconnectOverlay, Toasts } from './components/table-parts.js';
import { SignIn } from './screens/SignIn.js';
import { ProfileScreen } from './screens/Profile.js';
import { Lobby } from './screens/Lobby.js';
import { WaitingRoom } from './screens/WaitingRoom.js';
import { Table } from './screens/Table.js';

export function App() {
  const profile = useStore((s) => s.profile);
  const setProfile = useStore((s) => s.setProfile);
  const connect = useStore((s) => s.connect);
  const room = useStore((s) => s.room);
  const snapshot = useStore((s) => s.snapshot);
  const connection = useStore((s) => s.connection);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);

  const [restoring, setRestoring] = useState(true);
  const [showProfile, setShowProfile] = useState(false);

  // Restore the session on load. The httpOnly cookie proves who we are; the
  // stored token is what the socket handshake needs to present.
  useEffect(() => {
    api
      .me()
      .then(({ user }) => setProfile(user))
      .catch(() => {
        tokenStore.clear();
        setProfile(null);
      })
      .finally(() => setRestoring(false));
  }, [setProfile]);

  useEffect(() => {
    const token = tokenStore.get();
    if (profile && token) connect(token);
  }, [profile, connect]);

  // The saved volume applies to every sound, so it has to be pushed into the
  // engine as soon as the profile is known -- not only when it is edited.
  useEffect(() => {
    if (profile) sound.setVolume(profile.sfxVolume);
  }, [profile?.sfxVolume, profile]);

  // Watch the connection and say something when it degrades. Hysteresis stops
  // a single slow round-trip from firing a warning on an otherwise fine link.
  useNetworkAlerts();

  if (restoring) {
    return (
      <div className="grid h-screen-safe place-items-center text-sm text-white/35">
        loading…
      </div>
    );
  }

  if (!profile) {
    return <SignIn onSignedIn={setProfile} />;
  }

  const inGame = !!room && room.status !== 'waiting' && !!snapshot;

  if (showProfile && !room) {
    return (
      <div className="relative h-screen-safe">
        <ProfileScreen profile={profile} onClose={() => setShowProfile(false)} />
        <Toasts toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  }

  return (
    <div className="relative h-screen-safe">
      {!room ? (
        <Lobby profile={profile} onOpenProfile={() => setShowProfile(true)} />
      ) : inGame ? (
        <Table room={room} snapshot={snapshot} profile={profile} />
      ) : (
        <WaitingRoom room={room} profile={profile} />
      )}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
      <ReconnectOverlay connection={connection} />
    </div>
  );
}
