import { useEffect } from 'react';
import { useProgress, usePlaybackState, State } from 'react-native-track-player';

// Null-rendering poller: the only component that re-renders during steady-state
// playback. It mirrors playback position/state into SharedValues so the whole
// highlight + scroll pipeline runs on the UI thread with zero React work.
// Mount it only while the screen is focused — useProgress keeps polling the
// native module even when the screen is blurred but still mounted.
const PositionFeeder = ({ positionMsSV, isPlayingSV }) => {
    const { position, duration } = useProgress(100);
    const playbackState = usePlaybackState();

    useEffect(() => {
        // useProgress resets to {0,0,0} on track change — skip that transient
        // frame so the highlight doesn't flash back to the first word.
        if (position === 0 && duration === 0) return;
        positionMsSV.value = position * 1000;
    }, [position, duration, positionMsSV]);

    useEffect(() => {
        // playbackState.state is undefined until the first native fetch resolves.
        isPlayingSV.value = playbackState.state === State.Playing ? 1 : 0;
    }, [playbackState.state, isPlayingSV]);

    return null;
};

export default PositionFeeder;
