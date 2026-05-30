import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

interface PlaySoundCallbacks {
	onComplete?: () => void;
	isCanceled?: () => boolean;
	onProcessChange?: (process: ChildProcess) => void;
}

/**
 * Plays a sound file at the given volume using platform-specific commands.
 * Returns the primary ChildProcess, or null if playback was skipped.
 *
 * On macOS, volume is controlled via afplay -v (0.0-1.0).
 * On Linux, volume is controlled via paplay --volume (0-65536), with aplay fallback.
 */
export function playSoundFile(
	soundPath: string,
	volume: number = 100,
	callbacks?: PlaySoundCallbacks,
): ChildProcess | null {
	if (!existsSync(soundPath)) {
		console.warn(`[play-sound] Sound file not found: ${soundPath}`);
		return null;
	}

	const volumeDecimal = volume / 100;

	if (process.platform === "darwin") {
		return execFile("afplay", ["-v", volumeDecimal.toString(), soundPath], () =>
			callbacks?.onComplete?.(),
		);
	}

	if (process.platform === "win32") {
		// Best-effort playback via PowerShell MediaPlayer (handles mp3/wav/ogg).
		// Always resolves via onComplete — never retries — so a missing codec or
		// PowerShell does not spawn bogus fallbacks like the Linux path below.
		//
		// The path and volume are passed as ENV VARS, never interpolated into the
		// script text. This keeps data fully separated from code: even if a caller
		// later supplies a raw, user-controlled path (today it is always an
		// app-managed fixed filename), no PowerShell injection is possible.
		const psVolume = Math.max(0, Math.min(1, volumeDecimal));
		const script = [
			"Add-Type -AssemblyName presentationCore;",
			"$p = New-Object System.Windows.Media.MediaPlayer;",
			"$p.Open([uri]$env:DOYDECK_SOUND_PATH);",
			"$p.Volume = [double]$env:DOYDECK_SOUND_VOL;",
			"$p.Play();",
			// MediaPlayer.Play() is async; wait for the clip to finish (bounded).
			"$deadline = (Get-Date).AddSeconds(30);",
			"while (-not $p.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }",
			"if ($p.NaturalDuration.HasTimeSpan) { Start-Sleep -Seconds ([math]::Ceiling($p.NaturalDuration.TimeSpan.TotalSeconds)) }",
			"$p.Close();",
		].join(" ");
		return execFile(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{
				env: {
					...process.env,
					DOYDECK_SOUND_PATH: soundPath,
					// PowerShell parses this with [double]; force invariant "." decimal.
					DOYDECK_SOUND_VOL: psVolume.toString(),
				},
			},
			() => callbacks?.onComplete?.(),
		);
	}

	// Linux: paplay --volume accepts 0-65536 (65536 = 100%)
	const paVolume = Math.round(volumeDecimal * 65536);
	return execFile(
		"paplay",
		["--volume", paVolume.toString(), soundPath],
		(error) => {
			if (error) {
				if (callbacks?.isCanceled?.()) {
					callbacks?.onComplete?.();
					return;
				}
				if (volume === 0) {
					callbacks?.onComplete?.();
					return;
				}
				const fallback = execFile("aplay", [soundPath], () =>
					callbacks?.onComplete?.(),
				);
				callbacks?.onProcessChange?.(fallback);
				return;
			}
			callbacks?.onComplete?.();
		},
	);
}
