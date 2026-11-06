# Blank Demo

An iPhone app that shows a proved edit of a photo. You draw around part of a photo. In the sealed picture that area is plain grey. A proof shows how the sealed picture follows from a signed original. The rest of the picture comes from that original, re-encoded at lower quality.

Prototype, not audited.

The app's screens do not explain any of this, so the facts are here.

## What the app does

1. You take a photo, or choose one. The app draws it at 2600 px on its long side at most.
2. You draw a closed shape with a finger. A thin line follows the finger. When the finger lifts, the line goes away and the shape grows out to a 16 px grid, so the grid cells cover all of it. Two fingers zoom in, up to 5 times, and move the photo, and two quick taps go back. Lines land on the same grid at any zoom. A line too small to hold a cell adds nothing. You can draw more shapes: overlapping ones join, "Undo" removes the last one and "Clear" removes them all.
3. The app covers each area on the screen, with a yellow mask or with mosaic tiles.
4. "Blank this area" sends the photo and the area to the backend, which is a private dependency and is not in this repo. So the photo goes off the phone to our own server.
5. The answer is a plain copy of the sealed picture, a hash and a verdict. The picture appears only after the check passed and the whole answer matches what the app sent. Any other answer shows one fixed line and no picture. The screen shows no line saying it passed. The sealed file cannot be downloaded. The backend removes it and the photo after the picture is fetched, or after 600 s if it is never fetched. A service stop in that window can leave them until the next start.
6. After a result, "Start over" also takes the photo off the screen.

## The button

"Authorise this seal" shows with the picture, only if a web address is set. The address comes from Settings or from `WEB_URL` at launch, and it is not in this repo.
If the web side is ready, the button goes to the World app and back, with no page between, through World's IDKit package, pinned to 4.2.0. The package's result goes to the web side unchanged. "Authorised" shows only after the web side answers that it verified the result, or answers with a record for this hash. A refusal or a failure shows "Not authorised", and the button stays.
If the web side cannot be read or the World app cannot be opened, it opens that page in a sheet inside the app.
It sends the hash, the edit, the size and `from=app` to that page, in the link, with no photo. It also sends an event's short name, set in Settings or with `EVENT_SLUG` at launch, but only if it is 3 to 40 lowercase letters, digits and hyphens, with no hyphen first.
The page comes back through a `blankdemo://` link, and the app does not trust that link alone. "Authorised" shows only if the link names this hash and the web side then answers with a record for it. Anything else shows "Not authorised", and the button stays.

## Your name

Once, before the first authorising, and at any time from Settings, the app asks for a short name of 3 to 20 lowercase letters, digits or hyphens. The person proves in the World app that they are one human, and the web side checks that and makes an ENS name for them, in the background. The app keeps the name on the phone and shows "name being created" until the web side says it is done. If the World app cannot be opened from here, the app opens the web side's join page in a sheet, and believes the page's way back only when the web side then lists the name.
The registrar is our server, not a contract. The name goes on a public chain and stays there, and it links that person's photos across events.
When the web side is making an ENS name for a picture, the result shows "name being created" under "Authorised", then the name. If it is still not done after about 90 s, the app asks once more with the same token.

## The picture after authorising

After the web side verifies a new authorisation, the app sends it the picture with its cover, and the web side puts that picture on Swarm, where anyone can read it. How long Swarm keeps it is not promised.
The app makes that picture only from the backend's plain copy with the cover on top, flattened into one layer, with no metadata. It never uses the photo on the phone or the sealed file.
The link between a picture and its seal is the uploader's word. A failed send does not change "Authorised". It shows one line and a way to try again.

## The cover on the screen

"Cover" in Settings chooses a yellow mask, the default, or mosaic tiles.

- The mask is a flat yellow area with a yellow face on it, sized to the area. The face is a fixed picture in the app, and the app reads no pixel of your photo to draw it.
- The tiles take their colours from the pixels around the area. The app never reads a pixel inside it.

Both are drawn by the app. What you see in the area is made up. Neither is in the sealed file, and neither is proved. In the sealed file the area is plain grey, and the app sends the same edit with either choice. On the screen, both have a rounded edge and reach a little past the sealed cells.

## How to build it

You need Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```sh
cd app
xcodegen generate
open BlankDemo.xcodeproj
```

Choose your own signing team in Xcode, then run on a phone with iOS 17 or later.

The app needs the backend's address and an access word. Enter them under Settings in the app, or set `SERVICE_URL` and `SERVICE_WORD` when you launch it. Neither is in this repo. Without the backend you can still draw and see the cover, but you cannot send.

The app allows plain HTTP on a local network. Over plain HTTP the photo and the access word are not encrypted, so use a link you trust.

## Fonts

Public Sans, under the SIL Open Font License. The licence is beside it in `app/Fonts`.

## Licence

The code is under MIT, see `LICENSE`. The font is under its own licence. The zkSeal logo and the mask image are not covered by MIT.

## What the proof shows

- The sealed picture follows from a signed original by the stated change.
- Only the listed rectangles were edited. The rest comes from the signed original, re-encoded at lower quality.

## What the proof does not show

- **It is not a privacy guarantee.** The file still carries a map of the area, which can show outlines, even writing on plain paper, and the original's hash.
- **It does not show that a camera took the photo.** In this demo our test key signs the photo after the app sends it. That key is not on any trust list.
- **It does not cover the look on the screen.** The mask and the tiles are drawn by the app.
- **The authorise page does not check the seal.** It checks only the hash's format, so anyone can type a made-up hash and authorise it.
- **You cannot check it yourself.** The check is our server's word. The backend checks the proof, and the app shows the picture only if the check passed. The phone cannot recompute the hash, because it never holds the sealed file. The backend removes that file after the picture is fetched, or after 600 s if it is never fetched, and a service stop in that window can leave it until the next start. Once it is removed no one holds it, so the hash can no longer be checked against the file.
