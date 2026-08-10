# Testing on a phone from WSL2

Everything here was learned the hard way. Three separate problems stack up, and
each one presents as "adb is hanging", so they are easy to mistake for one
another.

## 1. Use one adb, not two

`/usr/bin/adb` is Debian's package (**34.0.4**) and comes first on `PATH`.
`~/Android/Sdk/platform-tools/adb` is the SDK's (**37.0.0**).

**Two adb versions cannot share a server.** When the versions differ, each one
kills the other's server and starts its own — so a command run from a shell using
one binary silently drops the connection held by the other. Symptom: the device
"keeps disconnecting" every few minutes for no apparent reason, and wireless
debugging takes the blame.

Fixed with a symlink in `~/.local/bin`, which precedes `/usr/bin` on `PATH` in
**both** interactive and non-interactive shells:

```bash
ln -sf "$HOME/Android/Sdk/platform-tools/adb" ~/.local/bin/adb
which adb && adb version     # expect 37.0.0
```

Editing `PATH` in `~/.bashrc` is **not** enough. Debian's `.bashrc` begins with

```sh
case $- in *i*) ;; *) return;; esac
```

so it returns immediately in a non-interactive shell — which is what most tooling
and any `bash -c` uses. The export never runs and `which adb` keeps reporting the
Debian one.

## 2. `adb start-server` hangs — run the server in the foreground instead

Starting the server the normal way blocks forever in this environment. It is not
mDNS and not the network: the server *does* bind, then its USB monitor is flooded
by Hyper-V vmbus netlink events. With `ADB_TRACE=all`, 44 of 59 startup lines are
`SUBSYSTEM = vmbus` / `SUBSYSTEM not found`. There are no USB devices; the
monitor is reacting to VM bus churn. The daemonise handshake never completes, so
the client waits on a server that is already running.

**Workaround — run it in the foreground in a terminal you leave open:**

```bash
adb nodaemon server
```

Then every other adb command works normally from any other shell. Confirm with:

```bash
ss -ltn | grep 5037
```

Do **not** `pkill -f adb` to clean up first: the pattern matches the wrapper
shell whose own command line contains "adb", so it kills itself. Use `pkill -x adb`.

## 3. Connecting

The phone is already paired, so **do not re-pair** — `adb pair` against an
already-paired device hangs rather than erroring. Once the server is up, adb's
mDNS auto-connect finds it:

```bash
adb devices -l
# adb-XXXXXXXXXXXXX-YYYYYY._adb-tls-connect._tcp   device   model:A069P
```

If it does not appear, toggle Wireless debugging off and on, then:

```bash
adb mdns services            # find the connect port
adb connect 192.168.4.68:<connect port>
```

The **pairing port and the connect port are different numbers**, and both rotate
every time the pairing dialog is reopened — a port from a minute ago is already
dead.

### Always pass `-s`

A stale offline emulator entry is enough to make adb refuse with "more than one
device". Select the phone by serial:

```bash
S=$(adb devices | awk '$2=="device" && $1!~/^emulator/ {print $1; exit}')
adb -s "$S" shell …
```

Note that `expo run:android` truncates the mDNS serial's
`._adb-tls-connect._tcp` suffix and then cannot find the device. Building with
Gradle directly and installing with `adb -s` avoids that.

## Installing a build

A **release**-signed APK installs straight over the store build as an update —
same key, so no conflict and no data loss:

```bash
export OASA_KEYSTORE_PATH=$PWD/oasa-release.keystore \
       OASA_KEYSTORE_PASSWORD=… OASA_KEY_ALIAS=… OASA_KEY_PASSWORD=…
npx expo prebuild && (cd android && ./gradlew assembleRelease)
adb -s "$S" install -r android/app/build/outputs/apk/release/app-release.apk
```

A **debug**-signed APK cannot replace it — different signing key,
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` — and it needs Metro running to serve JS.

Uninstalling from Settings can leave a **stub package record** carrying the old
signature: the app is gone from every user profile and `pm path` returns nothing,
yet installs still fail. `pm list packages -u` reveals it. Purge with:

```bash
adb -s "$S" uninstall com.itshix.fckoasa
```

This destroys retained app data, so export from Settings first if it matters.

### Metro over WSL2

The phone cannot reach WSL2's `localhost` directly. Reverse-forward the port:

```bash
adb -s "$S" reverse tcp:8081 tcp:8081
```

`expo start` may claim port 8081 is in use even when nothing in WSL is listening
(a Windows-side process visible through localhost forwarding). Run Metro on
another port and map the device's 8081 to it:

```bash
CI=1 npx expo start --dev-client --port 8082
adb -s "$S" reverse tcp:8081 tcp:8082
```

## Reading the app's own diagnostics

The app logs timing marks through `console.log`, which **survives release
builds** — there is no `drop_console` anywhere in the Metro/Babel toolchain, and
shipped code already relies on `console.warn` (`[boot]`, `[alert]`, `[planner]`).
Diagnostics are deliberately not `__DEV__`-gated, because this app is diagnosed
from release APKs installed off GitHub Releases.

```bash
adb -s "$S" logcat -s ReactNativeJS:V | grep mapperf
```

For a clean map-timing run the order matters:

```bash
adb -s "$S" logcat -c
adb -s "$S" shell am force-stop com.itshix.fckoasa
# cold-launch from the icon, wait ~10s on Home, then tap a saved line
adb -s "$S" logcat -d | grep mapperf
```

`force-stop` is required — the warm-up latches once per **process**. Waiting is
required — it arms ~250ms after boot and needs a moment to finish; tapping too
early logs `warmup skipped` and measures nothing.

Screenshots for checking layout:

```bash
adb -s "$S" exec-out screencap -p > /tmp/shot.png
```

Beware: Home sometimes launches with a ~250px top gap (a known bug), which moves
every element and makes coordinate-based `input tap` miss. Take a screenshot and
derive coordinates from it rather than reusing old ones.
