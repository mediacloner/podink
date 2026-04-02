import { Feather as Icon } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

const EpisodeItem = ({
  episode,
  onPress,
  onDownload,
  onTranscribe,
  onCancel,
  onDelete,
  isTranscribing,
  transcribeProgress,
  isDownloading,
  downloadProgress,
  isQueued,
  cardStyle,
}) => {
  const [expanded, setExpanded] = useState(false);
  const rotation = useSharedValue(0);

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    rotation.value = withSpring(next ? 1 : 0, { damping: 15 });
  };

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 180}deg` }],
  }));

  const formattedDate = new Date(episode.release_date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <View style={[styles.card, cardStyle]}>
      {/* Main row: tap anywhere = navigate to player */}
      <TouchableOpacity onPress={() => onPress(episode)} activeOpacity={0.7} style={styles.row}>
        {/* Left info — plain View, tap bubbles up to outer row */}
        <View style={styles.infoTouch}>
          <Text style={styles.podcastLabel} numberOfLines={1}>
            {episode.podcast_title}
          </Text>
          <Text style={styles.episodeTitle} numberOfLines={2}>
            {episode.title}
          </Text>
          <Text style={styles.date}>{formattedDate}</Text>
        </View>

        {/* Right: action buttons intercept their own touches */}
        <View style={styles.right} collapsable={false}>
          {!episode.is_downloaded ? (
            <TouchableOpacity
              style={[styles.pill, styles.pillBlue, isDownloading && styles.pillDisabled]}
              onPress={() => onDownload?.(episode)}
              disabled={isDownloading}
            >
              {isDownloading
                ? <ActivityIndicator size="small" color="#4FACFE" style={{ width: 13 }} />
                : <Icon name="arrow-down-circle" size={13} color="#4FACFE" />
              }
              <Text style={styles.pillBlueText}>
                {isDownloading
                  ? downloadProgress > 0 ? `${Math.round(downloadProgress)}%` : "…"
                  : "Download"}
              </Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.downloadedCol}>
              <View style={[styles.pill, styles.pillGreen]}>
                <Icon name="check" size={11} color="#34C759" />
                <Text style={styles.pillGreenText}>Downloaded</Text>
              </View>

              <View style={styles.actionRow}>
                {isTranscribing ? (
                  // Actively transcribing — tap to cancel
                  <TouchableOpacity
                    style={[styles.pill, styles.pillCancelling]}
                    onPress={() => onCancel?.(episode)}
                    activeOpacity={0.7}
                  >
                    <Icon name="x" size={12} color="#FF9F0A" />
                    <Text style={styles.pillCancelText}>
                      Transcribe {transcribeProgress > 0 ? `${transcribeProgress}%` : "…"}
                    </Text>
                  </TouchableOpacity>
                ) : isQueued && !episode.has_transcript ? (
                  // Waiting in queue — tap to remove
                  <TouchableOpacity
                    style={[styles.pill, styles.pillQueued]}
                    onPress={() => onCancel?.(episode)}
                    activeOpacity={0.7}
                  >
                    <Icon name="clock" size={11} color="#FF9F0A" />
                    <Text style={styles.pillQueuedText}>Queued</Text>
                    <Icon name="x" size={11} color="#FF453A" />
                  </TouchableOpacity>
                ) : onTranscribe && !episode.has_transcript ? (
                  <TouchableOpacity
                    style={[styles.pill, styles.pillSolid]}
                    onPress={() => onTranscribe(episode)}
                  >
                    <Icon name="zap" size={13} color="#fff" />
                    <Text style={styles.pillSolidText}>Transcribe</Text>
                  </TouchableOpacity>
                ) : episode.has_transcript ? (
                  <View style={styles.pill}>
                    <Icon name="align-left" size={11} color="#4FACFE" />
                    <Text style={styles.pillBlueText}>Transcript</Text>
                  </View>
                ) : null}

                {onDelete && (
                  <TouchableOpacity style={styles.iconBtn} onPress={() => onDelete(episode)}>
                    <Icon name="trash-2" size={15} color="#3A3A3C" />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </View>
      </TouchableOpacity>

      {/* Bottom strip (~20%): tap = expand/collapse description */}
      <TouchableOpacity onPress={toggleExpand} style={[styles.expandStrip, expanded && styles.expandStripOpen]} activeOpacity={0.6}>
        <Animated.View style={chevronStyle}>
          <Icon name="chevron-down" size={15} color="#3A3A3C" />
        </Animated.View>
      </TouchableOpacity>

      {/* Expanded description */}
      {expanded && (
        <Animated.View
          entering={FadeInDown.duration(200)}
          exiting={FadeOut.duration(150)}
          style={styles.description}
        >
          <Text style={styles.descriptionText}>
            {episode.description?.replace(/<[^>]+>/g, "") || "No description available."}
          </Text>
        </Animated.View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderBottomWidth: 0.5,
    borderBottomColor: "rgba(255,255,255,0.06)",
    backgroundColor: "#0C0C0E",
  },
  row: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
    gap: 14,
  },

  /* Info */
  infoTouch: { flex: 1, gap: 4 },
  podcastLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#4FACFE",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  episodeTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#FFFFFF",
    lineHeight: 21,
  },
  date: { fontSize: 12, color: "#636366" },

  /* Right column */
  right: { alignItems: "flex-end", justifyContent: "center", minWidth: 90 },

  /* Bottom expand strip */
  expandStrip: {
    alignItems: "center",
    justifyContent: "center",
    height: 24,
  },
  expandStripOpen: {
    borderTopWidth: 0.5,
    borderTopColor: "rgba(255,255,255,0.04)",
  },

  /* Pills */
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "rgba(79,172,254,0.10)",
    minWidth: 112,
  },
  pillBlue: {
    borderWidth: 0.5,
    borderColor: "rgba(79,172,254,0.25)",
  },
  pillBlueText: { fontSize: 12, fontWeight: "600", color: "#4FACFE" },
  pillSolid: { backgroundColor: "#4FACFE" },
  pillSolidText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  pillDisabled: { opacity: 0.45 },
  pillQueued: {
    backgroundColor: "rgba(255,159,10,0.10)",
    borderWidth: 0.5,
    borderColor: "rgba(255,159,10,0.25)",
  },
  pillQueuedText: { fontSize: 12, fontWeight: "600", color: "#FF9F0A" },
  pillCancelling: {
    backgroundColor: "rgba(255,159,10,0.10)",
    borderWidth: 0.5,
    borderColor: "rgba(255,159,10,0.25)",
  },
  pillCancelText: { fontSize: 12, fontWeight: "700", color: "#FF9F0A" },
  pillGreen: {
    backgroundColor: "rgba(52,199,89,0.10)",
    borderWidth: 0.5,
    borderColor: "rgba(52,199,89,0.25)",
  },
  pillGreenText: { fontSize: 12, fontWeight: "600", color: "#34C759" },

  /* Downloaded */
  downloadedCol: { alignItems: "flex-end", gap: 8 },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 8 },

  iconBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },

  /* Description */
  description: { paddingHorizontal: 20, paddingBottom: 16 },
  descriptionText: { fontSize: 13, color: "#AEAEB2", lineHeight: 20 },
});

export default EpisodeItem;
