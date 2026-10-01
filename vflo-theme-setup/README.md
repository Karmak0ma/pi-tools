# V.Flo terminal theme setup

This directory is a portable snapshot of the active configuration that controls colors and fonts across Kitty, tmux, Pi, and Herdr on the source computer. The files below were copied from the paths listed here; `pi/theme-selection.json` is a small extracted fragment, not a copy of the full Pi settings file.

## File map

| Bundled file | Source on the original computer | What it controls |
| --- | --- | --- |
| `kitty/kitty.conf` | `~/.config/kitty/kitty.conf` | Kitty font family and size, Monokai terminal background/foreground and ANSI palette, cursor color, and related terminal behavior. |
| `tmux/tmux.conf` | `~/.tmux.conf` | tmux true-color support, `tmux-256color`, status line, window labels, messages, and pane borders. tmux does not choose a font; it displays using the font provided by Kitty. |
| `herdr/config.toml` | `~/.config/herdr/config.toml` | Herdr custom active-row color and its agent/space sidebar token colors. The file also keeps other Herdr settings from the source configuration. |
| `pi/themes/monokai-vflo.json` | `~/repos/pi-tools/monokai-vflo/themes/monokai-vflo.json` | The `monokai-vflo` Pi theme palette for text, panels, tool output, Markdown, diffs, and syntax highlighting. |
| `pi/theme-selection.json` | Extracted from the `theme` field in `~/.pi/agent/settings.json` | Selects `monokai-vflo` in Pi. This is only the theme field; it is not a replacement for `settings.json`. |
| `pi/sidebar-vflo.json` | `~/.pi/agent/sidebar-vflo.json` | Pi sidebar color preset (`monokai`), width, startup visibility, and visible panels. |
| `pi/pi-statusline.json` | `~/.pi/agent/pi-statusline.json` | Pi status-line palette (`tokyo-night`), density, segments, and segment labels. |

Pi and Herdr do not set a separate terminal font in these files. They render in the terminal, so Kitty's font setting applies to them too.

## Install on another computer

Back up the existing files first. From this directory, copy the files to their normal locations:

```sh
mkdir -p ~/.config/kitty ~/.config/herdr ~/.pi/agent/themes
cp kitty/kitty.conf ~/.config/kitty/kitty.conf
cp tmux/tmux.conf ~/.tmux.conf
cp herdr/config.toml ~/.config/herdr/config.toml
cp pi/themes/monokai-vflo.json ~/.pi/agent/themes/monokai-vflo.json
cp pi/sidebar-vflo.json ~/.pi/agent/sidebar-vflo.json
cp pi/pi-statusline.json ~/.pi/agent/pi-statusline.json
```

Then merge the value in `pi/theme-selection.json` into `~/.pi/agent/settings.json`:

```json
"theme": "monokai-vflo"
```

Do not replace the whole `settings.json` with the fragment. Keep the other machine's providers, packages, and settings. Restart or reload the tools after copying the files.

## Dependencies and machine-specific edits

- **Kitty font:** Install the `JetBrainsMonoNL Nerd Font Mono` family on the new computer. Kitty is set to use it at `10.0` points. The font files are not included in this configuration-only bundle. Kitty must be able to see the installed font; a font installed only for another environment (for example, Windows rather than Kitty running in WSL) may not be available.
- **Herdr glyphs and plugins:** The sidebar uses Nerd Font glyphs and agent icons. Install the same Herdr plugins used on the source computer, including `hhdebb.herdr-radar`; that plugin supplies its icon font. The rename-agent key also depends on the `vflo.subagents.rename-current-agent` plugin action. Remove or change that key if the plugin is not installed.
- **Herdr local path:** The `herdr/config.toml` tab-bar command reads `/home/vflores/.local/state/herdr/plugins/hhdebb.herdr-radar/tabbar.txt`. Change this to the matching path on the new computer or remove the Herdr-radar tab-bar block if it is not used there.
- **Pi extensions:** Install the Pi sidebar and status-line extensions that read `sidebar-vflo.json` and `pi-statusline.json`. The theme JSON provides the palette. The source `monokai-vflo` package also contains an extension that changes Pi rendering; it is not bundled here because this directory contains configuration files only. Install that package separately if you want its custom rendering behavior as well as its colors.
- **tmux plugins and terminfo:** The tmux configuration expects TPM, `tmux-sensible`, and `tmux-cpu`, and uses the `gitmux` command. It sets `default-terminal` to `tmux-256color`, so that terminfo entry must be available on the new computer. The source config also calls `gitmux -cfg ~/.gitmux.conf`, but no `~/.gitmux.conf` was present when this bundle was made. Supply that file if you use this status segment, or edit the status line to remove the `-cfg` option/segment.

This bundle intentionally excludes the full Pi `settings.json`, installed plugin code, runtime state, and font binaries. Those items are either machine-specific or are not configuration files for the color/font setup.
