# Blank Demo

An iPhone app that shows a proved edit of a photo. You draw around part of a photo. In the sealed picture that area is plain grey. A proof shows how the sealed picture follows from a signed original. The rest of the picture comes from that original, re-encoded at lower quality.

Prototype, not audited.

The app's screens do not explain any of this, so the facts are here.

## What the app does

1. You take a photo, or choose one. The app draws it at 2600 px on its long side at most.
2. You draw a closed shape with a finger. A thin line follows the finger. When the finger lifts, the line goes away and the shape grows out to a 16 px grid, so the grid cells cover all of it.
3. The app fills the area with flat yellow and puts a yellow face on it.
4. "Blank this area" sends the photo and the area to the backend, which is a private dependency and is not in this repo. So the photo goes off the phone to our own server.
5. The answer is a plain copy of the sealed picture, a hash and a verdict. The picture appears only after the check passed and the whole answer matches what the app sent. Any other answer shows one fixed line and no picture. The screen shows no line saying it passed. The sealed file cannot be downloaded. The backend removes it and the photo after the picture is fetched, or after 600 s if it is never fetched. A service stop in that window can leave them until the next start.
6. After a result, "Start over" also takes the photo off the screen.

## The button

"Authorise this seal" shows with the picture, only if a web address is set. It opens that page in the browser. The address comes from Settings or from `WEB_URL` at launch, and it is not in this repo.
It sends the hash, the edit and the size to that page, in the link. It sends no photo.

## The yellow face on the screen

The app draws a flat yellow area with a yellow face on it, on its own screen. The face is a fixed picture in the app, and the app reads no pixel of your photo to draw it. What you see in the area is made up. It is not in the sealed file and it is not proved. In the sealed file the area is plain grey.

## How to build it

You need Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```sh
cd app
xcodegen generate
open BlankDemo.xcodeproj
```

Choose your own signing team in Xcode, then run on a phone with iOS 17 or later.

The app needs the backend's address and an access word. Enter them under Settings in the app, or set `SERVICE_URL` and `SERVICE_WORD` when you launch it. Neither is in this repo. Without the backend you can still draw and see the face, but you cannot send.

The app allows plain HTTP on a local network. Over plain HTTP the photo and the access word are not encrypted, so use a link you trust.

## Fonts

Public Sans, under the SIL Open Font License. The licence is beside it in `app/Fonts`.

## What the proof shows

- The sealed picture follows from a signed original by the stated change.
- Only the listed rectangles were edited. The rest comes from the signed original, re-encoded at lower quality.

## What the proof does not show

- **It is not a privacy guarantee.** The file still carries a map of the area, which can show outlines, even writing on plain paper, and the original's hash.
- **It does not show that a camera took the photo.** In this demo our test key signs the photo after the app sends it. That key is not on any trust list.
- **It does not cover the look on the screen.** The yellow face is drawn by the app.
- **You cannot check it yourself.** The check is our server's word. The backend checks the proof, and the app shows the picture only if the check passed. The phone cannot recompute the hash, because it never holds the sealed file. The backend removes that file after the picture is fetched, or after 600 s if it is never fetched, and a service stop in that window can leave it until the next start. Once it is removed no one holds it, so the hash can no longer be checked against the file.
