import { useEffect, useState } from 'react';
import { getSyncQueueIds, getSyncingId, onBookSyncChange } from '../services/bookService';

/**
 * Which chapters are having their book text matched to the voice right now
 * (bookService's own small queue), for the rows and the collection header.
 */
export const useBookSync = () => {
    const [state, setState] = useState(() => ({ syncingId: getSyncingId(), syncQueueIds: getSyncQueueIds() }));
    useEffect(() => {
        const read = () => setState({ syncingId: getSyncingId(), syncQueueIds: getSyncQueueIds() });
        read();
        return onBookSyncChange(read);
    }, []);
    return state;
};
