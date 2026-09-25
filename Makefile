UUID     = clipvault@yeyo11.github.io
ZIP      = $(UUID).shell-extension.zip
SOURCES  = extension.js prefs.js stylesheet.css metadata.json $(wildcard lib/*.js)
SCHEMA   = schemas/org.gnome.shell.extensions.clipvault.gschema.xml
POT      = po/clipvault.pot
PO_FILES = $(wildcard po/*.po)

.PHONY: all pack dist review install uninstall enable disable prefs pot update-po logs lint clean

all: pack

## Build the installable zip (what gets uploaded to extensions.gnome.org)
pack: $(ZIP)

$(ZIP): $(SOURCES) $(SCHEMA) $(PO_FILES)
	gnome-extensions pack --force \
		--extra-source=lib \
		--schema=$(SCHEMA) \
		--podir=po \
		--gettext-domain=$(UUID) \
		.

## Build the same zip without GNOME tools (used by CI and the release workflow)
dist: $(SOURCES) $(SCHEMA) $(PO_FILES)
	rm -rf build $(ZIP)
	mkdir -p build/schemas
	cp -r metadata.json extension.js prefs.js stylesheet.css lib build/
	cp $(SCHEMA) build/schemas/
	for po in $(PO_FILES); do \
		lang=$$(basename $$po .po); \
		mkdir -p build/locale/$$lang/LC_MESSAGES; \
		msgfmt $$po -o build/locale/$$lang/LC_MESSAGES/$(UUID).mo; \
	done
	cd build && zip -qr ../$(ZIP) .
	rm -rf build

## Run the extensions.gnome.org static analyzer (pip install shexli "tree-sitter==0.25.*")
review: dist
	shexli $(ZIP)

## Install for the current user (restart GNOME Shell afterwards)
install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Installed. X11: Alt+F2, type r, Enter. Wayland: log out and back in. Then: make enable"

uninstall:
	-gnome-extensions disable $(UUID)
	-gnome-extensions uninstall $(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

## Regenerate the translation template from the sources
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
		--package-name=ClipVault --msgid-bugs-address=https://github.com/yeyo11/clipvault/issues \
		--add-comments=Translators: --output=$(POT) \
		extension.js prefs.js lib/*.js

## Merge new strings into every translation
update-po: pot
	for po in $(PO_FILES); do msgmerge --update --backup=none --previous $$po $(POT); done

## Check translations compile cleanly
lint:
	for po in $(PO_FILES); do msgfmt --check --output-file=/dev/null $$po; done
	glib-compile-schemas --strict --dry-run schemas

## Follow GNOME Shell logs for this extension
logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -i -E "clipvault|JS ERROR"

clean:
	rm -rf $(ZIP) build schemas/gschemas.compiled
