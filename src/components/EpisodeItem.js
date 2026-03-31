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
  FadeInUp,
  FadeOut,
  Layout,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

const EpisodeItem = ({
  episode,
  onPress,
  onDownload,
  onTranscribe,
  onDelete,
  isTranscribing,
  transcribeProgress,
}) => {
  const [expanded, setExpanded] = useState(false);
  const rotation = useSharedValue(0);

  const toggleExpand = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    rotation.value = withSpring(nextExpanded ? 1 : 0, { damping: 15 });
  };

  const animatedIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 180}deg` }],
  }));

  return (
    <View style={styles.cardContainer}>
      <TouchableOpacity
        style={styles.container}
        onPress={() => onPress(episode)}
      >
        <View style={styles.details}>
          <Text style={styles.podcastTitle}>{episode.podcast_title}</Text>
          <Text style={styles.title} numberOfLines={2}>
            {episode.title}
          </Text>
          <Text style={styles.date}>
            {new Date(episode.release_date).toLocaleDateString()}
          </Text>
        </View>
        <View style={styles.actions}>
          {!episode.is_downloaded ? (
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => onDownload(episode)}
            >
              <Icon
                name="download"
                size={16}
                color="#fff"
                style={styles.iconSpaced}
              />
              <Text style={styles.btnText}>Download</Text>
            </TouchableOpacity>
          ) : (
            <View style={styles.downloadedActions}>
              <View style={styles.badgeRow}>
                <Icon
                  name="check-circle"
                  size={14}
                  color="#4ae26d"
                  style={styles.iconSpaced}
                />
                <Text style={styles.downloadedBadge}>Downloaded</Text>
              </View>
              <View style={styles.btnRow}>
                {onTranscribe && !episode.has_transcript ? (
                  <TouchableOpacity
                    style={[
                      styles.actionBtn,
                      styles.transcribeBtn,
                      isTranscribing && styles.disabledBtn,
                    ]}
                    onPress={() => onTranscribe(episode)}
                    disabled={!!isTranscribing}
                  >
                    {isTranscribing ? (
                      <ActivityIndicator
                        size="small"
                        color="#fff"
                        style={styles.iconSpaced}
                      />
                    ) : (
                      <Icon
                        name="file-text"
                        size={14}
                        color="#fff"
                        style={styles.iconSpaced}
                      />
                    )}
                    <Text style={styles.btnText}>
                      {isTranscribing
                        ? transcribeProgress > 0
                          ? `Transcribing ${transcribeProgress}%`
                          : transcribeProgress < 0
                            ? `Converting ${Math.abs(transcribeProgress)}%`
                            : "Converting..."
                        : "Transcribe"}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.transcriptBadge}>
                    <Icon
                      name="align-left"
                      size={12}
                      color="#4a90e2"
                      style={styles.iconSpaced}
                    />
                    <Text style={styles.transcriptBadgeText}>
                      Transcript Ready
                    </Text>
                  </View>
                )}
                {onDelete && (
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.deleteBtn]}
                    onPress={() => onDelete(episode)}
                  >
                    <Icon name="trash-2" size={14} color="#fff" />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
        </View>
        <TouchableOpacity style={styles.expandBtn} onPress={toggleExpand}>
          <Animated.View style={animatedIconStyle}>
            <Icon name="chevron-down" size={20} color="#888" />
          </Animated.View>
        </TouchableOpacity>
      </TouchableOpacity>
      {expanded && (
        <Animated.View
          entering={FadeInUp.duration(300)}
          exiting={FadeOut.duration(200)}
          style={styles.expandedContent}
        >
          <Text style={styles.descriptionText}>
            {episode.description?.replace(/<[^>]+>/g, "") ||
              "No description available."}
          </Text>
        </Animated.View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  cardContainer: { borderBottomWidth: 1, borderBottomColor: "#333" },
  container: {
    padding: 16,
    paddingRight: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  details: { flex: 1, paddingRight: 10 },
  podcastTitle: { fontSize: 12, color: "#aaa", marginBottom: 4 },
  title: { fontSize: 16, fontWeight: "bold", color: "#fff", marginBottom: 4 },
  date: { fontSize: 12, color: "#888" },
  actions: { alignItems: "flex-end", justifyContent: "center" },
  actionBtn: {
    backgroundColor: "#4a90e2",
    padding: 8,
    borderRadius: 5,
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
  },
  transcribeBtn: { backgroundColor: "#e24a4a", marginRight: 8 },
  deleteBtn: { backgroundColor: "#333" },
  downloadedActions: { alignItems: "flex-end" },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 4,
    marginBottom: 4,
  },
  btnRow: { flexDirection: "row", alignItems: "center" },
  downloadedBadge: { color: "#4ae26d", fontSize: 12 },
  btnText: { color: "#fff", fontSize: 12, fontWeight: "bold" },
  iconSpaced: { marginRight: 4 },
  expandBtn: { padding: 10 },
  expandedContent: { paddingHorizontal: 16, paddingBottom: 16, paddingTop: 4 },
  descriptionText: { color: "#ccc", fontSize: 13, lineHeight: 20 },
  disabledBtn: { opacity: 0.6 },
  transcriptBadge: {
    flexDirection: "row",
    alignItems: "center",
    marginRight: 8,
  },
  transcriptBadgeText: { color: "#4a90e2", fontSize: 12, fontWeight: "bold" },
});

export default EpisodeItem;
