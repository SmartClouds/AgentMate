=== Runova Connector ===
Contributors: runova
Tags: deploy, development, sync, themes, plugins
Requires at least: 6.0
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 2.2.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Lets the Runova desktop app pull and deploy this site's theme and plugin files over a signed connection.

== Description ==

Runova Connector pairs this site with the Runova app on your computer. Runova can then copy your themes, plugins and mu-plugins into a local project, and (with a write key) deploy changes back.

* Every request is signed with a key made for one computer, and every reply is signed by the site.
* Keys are made in Tools > Runova Connector (Network Admin > Settings on multisite) or with `wp runova key create`. A key works once, for 15 minutes.
* Read-only keys can never change anything. Write keys need an admin who can install plugins and themes.
* Only theme, plugin and mu-plugin folders are touched. Uploads, the database, WordPress core and wp-config.php are never read or written.
* Agent and Runova files (.claude, .agents, AGENTS.md, CLAUDE.md, .mcp.json, .runova and more), secrets and version control folders are refused, whatever the app asks for.
* A write key can also update the connector itself from the app (see "Updating" below).

== Updating ==

When the app ships a newer connector, it offers to update the one on your site. The site first tries to download that release itself, and only from the Runova GitHub release of that version (https://github.com/SmartClouds/Runova/releases). The app tells it the size and SHA-256 of every file over the signed connection, and the site takes the download only when every file matches. If the site can't reach GitHub, or what it gets differs, nothing is changed and the app sends the files itself over the same signed connection. Either way the connector checks each file's hash and path and parses every PHP file before it writes anything, builds the new folder beside the old one, swaps the two, and runs the same health checks a deploy does. If a check that passed before fails now, the old folder is put back and the app says so. Nothing else runs while a deploy is open.

Updating needs a write key and the same rights as a deploy. You can still update by uploading the zip in Plugins > Add New; that always works.

== Switches for wp-config.php ==

* `define( 'RUNOVA_CONNECTOR_DISABLED', true );` turns the connector off.
* `define( 'RUNOVA_CONNECTOR_READ_ONLY', true );` allows reading only, for every key. The app cannot update the connector then either.
* `define( 'RUNOVA_CONNECTOR_DATA_DIR', '/path/outside/the/web/root' );` moves the private data folder.
* `DISALLOW_FILE_MODS` is honoured: with it set, nothing can be deployed or updated from the app.

== Removing it ==

Deactivating the connector first rolls back any deploy still waiting to be confirmed, then removes its guard from mu-plugins. Deleting it from the Plugins screen (or `wp plugin uninstall runova-connector`) also drops its tables, settings and private data folder. Your themes and plugins are never touched.

`wp plugin delete` only removes the plugin's files and skips that clean-up, so use `wp plugin uninstall` from the command line.

== Changelog ==

= 1.0.0 =
* First release.
