import React, { useCallback } from 'react';
import SwipeableRow from './SwipeableRow';
import { showAlert } from './AppAlert';
import { isImportedEpisode, removeEpisodeDownload, removeEpisodeTranscript } from '../services/episodeService';
import { log } from '../services/logService';
import { useTheme } from '../theme';

/**
 * The Library's swipes on a downloaded episode, for every list that shows
 * one (user, 5.7.5: "I want the slide action in my library that can do it
 * in my podcast and feed"): swipe right removes the transcript, swipe left
 * deletes the download. A row that is not on the device has nothing to
 * remove and does not swipe.
 *
 * Both actions announce themselves (libraryEvents), so each list reloads
 * from its own listener; onChanged is for a list that reloads by hand.
 *
 * deleteDismiss — how the row answers a delete. By default a feed episode
 * stays where it is, showing Download again ('ack'), and imported audio,
 * whose row goes with its file, slides out. The Library, where every row
 * leaves with its download, passes 'slide-out'.
 */
const EpisodeSwipeRow = ({ episode, isDownloading, deleteDismiss, onChanged, children }) => {
    const { colors } = useTheme();

    const handleRemoveTranscript = useCallback(async () => {
        try {
            await removeEpisodeTranscript(episode);
        } catch (e) {
            log('UI', 'Remove transcript failed', { id: episode.id, error: e?.message || String(e) });
            showAlert('Could not remove the transcript', 'Please try again.');
        }
        onChanged?.();
    }, [episode, onChanged]);

    const handleDelete = useCallback(async () => {
        try {
            // Dequeues, stops the player if this is the loaded track, deletes
            // file + transcript (a feed row stays, an imported one goes).
            await removeEpisodeDownload(episode);
        } catch (e) {
            log('UI', 'Delete failed', { id: episode.id, error: e?.message || String(e) });
            showAlert('Delete failed', 'Could not remove this episode. Please try again.');
            onChanged?.();
            return false; // a slid-out row springs back
        }
        onChanged?.();
    }, [episode, onChanged]);

    const onDevice = !!episode.is_downloaded && !isDownloading;
    const leftAction = onDevice && episode.has_transcript ? {
        icon: 'x-circle',
        label: 'Transcript',
        color: colors.indigo,
        dismiss: 'ack',
        onPress: handleRemoveTranscript,
        accessibilityLabel: `Remove transcript for ${episode.title}`,
    } : undefined;
    const rightAction = onDevice ? {
        icon: 'trash-2',
        color: colors.danger,
        dismiss: deleteDismiss || (isImportedEpisode(episode) ? 'slide-out' : 'ack'),
        onPress: handleDelete,
        accessibilityLabel: `Delete ${episode.title}`,
    } : undefined;

    return (
        <SwipeableRow leftAction={leftAction} rightAction={rightAction}>
            {children}
        </SwipeableRow>
    );
};

export default EpisodeSwipeRow;
