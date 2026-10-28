#!/usr/bin/env python3
"""Installer window layout: the `.DS_Store` of the mounted image.

The records are the ones Finder itself wrote while the layout was set through
AppleScript, read back from a Finder-made image: the window (`bwsp`), the icon
view and its background (`icvp`), the view version (`vSrn`) and where each item
stands (`Iloc`). Written here, the build needs no Finder window on screen — no
half-made window flashing up on every build — and no permission to script
Finder.

Finder also keeps a bookmark to the background (`pBBk`); this one does not.
A bookmark made by `mac_alias` is one current Finder cannot resolve, and it
does not fall back to the alias then: the window opens with no background at
all. The alias alone is resolved.

`write` lays the window out on the read-write image; `check` reads the image
that ships and fails unless it carries exactly that layout.

Needs `ds_store` and `mac_alias`; `scripts/build-dmg-macos.sh` bootstraps a
pinned repo-local venv for them (see `scripts/dmg/requirements.txt`).
"""

import argparse
import datetime
import os
import sys

import ds_store.store
from ds_store import DSStore
from mac_alias import Alias
from mac_alias.alias import ALIAS_FIXED_DISK, ALIAS_KIND_FILE, VolumeInfo, TargetInfo

BACKGROUND_FOLDER = ".background"
BACKGROUND = os.path.join(BACKGROUND_FOLDER, "background.tiff")

# Fixed values so the .DS_Store is byte-identical on every build.  Finder resolves
# the alias by POSIX path when the CNIDs do not match the recipient's volume.
_FIXED_EPOCH = datetime.datetime(2000, 1, 1, 0, 0, 0, tzinfo=datetime.timezone.utc)


def _mac_epoch_seconds(dt):
    from mac_alias.utils import mac_epoch
    return int((dt - mac_epoch).total_seconds())


def make_background_alias(background):
    alias = Alias()
    alias.target = TargetInfo(
        kind=ALIAS_KIND_FILE,
        filename=os.path.basename(background).encode("utf-8"),
        folder_cnid=2,
        cnid=3,
        creation_date=_FIXED_EPOCH,
        creator_code=b"\0\0\0\0",
        type_code=b"\0\0\0\0",
        folder_name=BACKGROUND_FOLDER.encode("utf-8"),
        posix_path=b"/" + BACKGROUND.encode("utf-8"),
        carbon_path=b"VibeIDE:" + BACKGROUND.encode("utf-8").replace(b"/", b":"),
    )
    alias.volume = VolumeInfo(
        name=b"VibeIDE",
        creation_date=_FIXED_EPOCH,
        fs_type=b"H+",
        disk_type=ALIAS_FIXED_DISK,
        attribute_flags=0,
        fs_id=b"\0\0",
        posix_path=b"/Volumes/VibeIDE",
    )
    return alias.to_bytes()

# What Finder writes for "icon view, not arranged, labels under the icons";
# the icon size and the background are added per image.
ICON_VIEW = {
    "viewOptionsVersion": 1,
    "arrangeBy": "none",
    "gridOffsetX": 0.0,
    "gridOffsetY": 0.0,
    "gridSpacing": 100.0,
    "labelOnBottom": True,
    "showIconPreview": True,
    "showItemInfo": False,
    "textSize": 12.0,
    "backgroundColorRed": 1.0,
    "backgroundColorGreen": 1.0,
    "backgroundColorBlue": 1.0,
    # 2 is "picture"; 1 would be the plain colour above.
    "backgroundType": 2,
}

BARS_HIDDEN = {
    "ShowToolbar": False,
    "ShowStatusBar": False,
    "ShowSidebar": False,
    "ContainerShowSidebar": False,
    "ShowTabView": False,
}


def point(text):
    x, y = text.split(",")

    return int(x), int(y)


def window_bounds(args):
    """`bwsp` keeps the window in Cocoa screen space: the origin is its
    bottom-left corner, and the height includes the title bar.

    The anchor is fixed so the layout is deterministic across machines and
    never depends on the builder's screen size. x=100, y=100 leaves the window
    well inside a 1200 pt screen: the top of the 380 pt window is at y=480."""
    height = args.window_height + args.title_bar

    return "{{%d, %d}, {%d, %d}}" % (100, 100, args.window_width, height)


def write(args):
    background = os.path.join(args.mount, BACKGROUND)

    if not os.path.isfile(background):
        sys.exit(f"layout: no background at {background}")

    with DSStore.open(os.path.join(args.mount, ".DS_Store"), "w+") as store:
        store["."]["bwsp"] = dict(BARS_HIDDEN, WindowBounds=window_bounds(args))
        store["."]["icvp"] = dict(
            ICON_VIEW,
            iconSize=float(args.icon_size),
            backgroundImageAlias=make_background_alias(background),
        )
        store["."]["vSrn"] = ("long", 1)
        store[args.app]["Iloc"] = args.app_position
        store["Applications"]["Iloc"] = args.applications_position
        # A Finder that shows hidden files shows this folder whatever its
        # name and flags; given no place, it lands in the window.
        store[BACKGROUND_FOLDER]["Iloc"] = args.background_folder_position


def check(args):
    """Every record `write` puts down, read back from the image that ships."""
    # A bookmark here is reported, not parsed: whichever tool left it, its
    # presence alone is what hides the background.
    ds_store.store.codecs.pop(b"pBBk", None)

    path = os.path.join(args.mount, ".DS_Store")

    if not os.path.isfile(path):
        return ["no .DS_Store: the window would open as a plain file list"]

    problems = []

    with DSStore.open(path, "r") as store:
        records = {(entry.filename, entry.code.decode()): entry.value for entry in store}

    window = records.get((".", "bwsp")) or {}

    if window.get("WindowBounds") != window_bounds(args):
        problems.append(f"window bounds {window.get('WindowBounds')!r}, expected {window_bounds(args)!r}")

    problems += [f"{bar} is not hidden" for bar in BARS_HIDDEN if window.get(bar) is not False]

    view = records.get((".", "icvp")) or {}

    if view.get("backgroundType") != 2 or not view.get("backgroundImageAlias"):
        problems.append("the icon view has no background picture")
    elif Alias.from_bytes(view["backgroundImageAlias"]).target.filename != os.path.basename(BACKGROUND):
        problems.append("the background alias points at another file")

    if view.get("iconSize") != float(args.icon_size) or view.get("arrangeBy") != "none":
        problems.append(f"icon view {view.get('iconSize')!r}/{view.get('arrangeBy')!r}")

    if (".", "pBBk") in records:
        problems.append("a background bookmark (pBBk): Finder would show no background")

    places = (
        (args.app, args.app_position),
        ("Applications", args.applications_position),
        (BACKGROUND_FOLDER, args.background_folder_position),
    )

    for name, expected in places:
        if records.get((name, "Iloc")) != expected:
            problems.append(f"{name} at {records.get((name, 'Iloc'))}, expected {expected}")

    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("mode", choices=["write", "check"])
    parser.add_argument("mount")
    parser.add_argument("--app", required=True, help="the bundle's name, NAME.app")
    parser.add_argument("--window-width", type=int, required=True)
    parser.add_argument("--window-height", type=int, required=True, help="content, without the title bar")
    parser.add_argument("--title-bar", type=int, required=True)
    parser.add_argument("--icon-size", type=int, required=True)
    parser.add_argument("--app-position", type=point, required=True, help="X,Y of the icon's centre")
    parser.add_argument("--applications-position", type=point, required=True)
    parser.add_argument("--background-folder-position", type=point, required=True, help="below the window")
    args = parser.parse_args()

    if args.mode == "write":
        write(args)

        return

    problems = check(args)

    for problem in problems:
        print(f"layout: {problem}", file=sys.stderr)

    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
