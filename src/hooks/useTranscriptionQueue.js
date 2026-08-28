import { useEffect, useState } from 'react';
import { getAbortingId, getActiveId, getQueueIds, onQueueChange } from '../services/whisperService';

const read = () => {
    const active = getActiveId();
    return {
        // A job being cancelled is not "transcribing" any more — hide it
        // until the service confirms it is gone.
        activeId: active !== null && getAbortingId() !== active ? active : null,
        queuedIds: getQueueIds(), // waiting items only; the active one is not in here
    };
};

/**
 * Live view of the transcription queue for list screens: which episode is
 * being transcribed right now and which are waiting. Re-renders on every
 * queue change (enqueue, start, cancel, finish); the per-row percent comes
 * from whisperService.onTranscriptProgress inside EpisodeItem, so a 1 % tick
 * never re-renders a whole list.
 */
export const useTranscriptionQueue = () => {
    const [state, setState] = useState(read);
    useEffect(() => onQueueChange(() => setState(read())), []);
    return state;
};
