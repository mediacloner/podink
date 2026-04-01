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
  onDelete,
  isTranscribing,
  transcribeProgress,
  isDownloading,
  downloadProgress,
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
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.row}
        onPress={() => onPress(episode)}
        activeOpacity={0.7}
      >
        {/* Left: info */}
        <View style={styles.info}>
          <Text style={styles.podcastLabel} numberOfLines={1}>
            {episode.podcast_title}
          </Text>
          <Text style={styles.episodeTitle} numberOfLines={2}>
            {episode.title}
          </Text>
          <Text style={styles.date}>{formattedDate}</Text>
        </View>

        {/* Right: actions + chevron */}
        <View style={styles.right}>
          {!episode.is_downloaded ? (
            /* ── Download button ── */
            <TouchableOpacity
              style={[styles.pill, styles.pillBlue, isDownloading && styles.pillDisabled]}
              onPress={() => onDownload(episode)}
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
            /* ── Downloaded state ── */
            <View style={styles.downloadedCol}>
              <View style={styles.downloadedBadge}>
                <Icon name="check" size={11} color="#34C759" />
                <Text style={styles.downloadedText}>Downloaded</Text>
              </View>

              <View style={styles.actionRow}>
                {onTranscribe && !episode.has_transcript ? (
                  <TouchableOpacity
                    style={[styles.pill, styles.pillSolid, isTranscribing && styles.pillDisabled]}
                    onPress={() => onTranscribe(episode)}
                    disabled={!!isTranscribing}
                  >
                    {isTranscribing
                      ? <ActivityIndicator size="small" color="#fff" style={{ width: 13 }} />
                      : <Icon name="zap" size={13} color="#fff" />
                    }
                    <Text style={styles.pillSolidText}>
                      {isTranscribing
                        ? transcribeProgress > 0 ? `${transcribeProgress}%`
                          : transcribeProgress < 0 ? `${Math.abs(transcribeProgress)}%`
                          : "…"
                        : "Transcribe"}
                    </Text>
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

          {/* Expand chevron */}
          <TouchableOpacity
            style={styles.chevron}
            onPress={toggleExpand}
            hitSlop={{ top: 8, bottom: 8, left: 10, right: 10 }}
          >
            <Animated.View style={chevronStyle}>
              <Icon name="chevron-down" size={16} color="#3A3A3C" />
            </Animated.View>
          </TouchableOpacity>
        </View>
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
    paddingVertical: 16,
    gap: 14,
  },

  /* Info */
  info: { flex: 1, gap: 4 },
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
  right: { alignItems: "flex-end", justifyContent: "space-between", minWidth: 90 },

  /* Pills */
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "rgba(79,172,254,0.10)",
  },
  pillBlue: {
    borderWidth: 0.5,
    borderColor: "rgba(79,172,254,0.25)",
  },
  pillBlueText: { fontSize: 12, fontWeight: "600", color: "#4FACFE" },
  pillSolid: { backgroundColor: "#4FACFE" },
  pillSolidText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  pillDisabled: { opacity: 0.45 },

  /* Downloaded */
  downloadedCol: { alignItems: "flex-end", gap: 8 },
  downloadedBadge: { flexDirection: "row", alignItems: "center", gap: 4 },
  downloadedText: { fontSize: 11, fontWeight: "600", color: "#34C759" },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 8 },

  iconBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },

  chevron: { marginTop: 10 },

  /* Description */
  description: { paddingHorizontal: 20, paddingBottom: 16 },
  descriptionText: { fontSize: 13, color: "#AEAEB2", lineHeight: 20 },
});

export default EpisodeItem;
