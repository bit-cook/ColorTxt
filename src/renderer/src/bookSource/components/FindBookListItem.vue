<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DefaultBookCover from "./DefaultBookCover.vue";
import type { SearchBookItem } from "@shared/bookSource/types";
import {
  formatBookAuthor,
  formatBookIntroForDisplay,
  getBookKindList,
} from "../bookSourceDisplay";
import { useFindBookBookshelf } from "../composables/useFindBookBookshelf";
import { isBookshelfCaughtUpToLatest } from "../findBookshelfDisplay";
import { icons } from "../../icons";

const props = withDefaults(
  defineProps<{
    item: SearchBookItem;
    /** 是否在标题行右侧显示书源名（搜索、书架为 true，发现分类为 false） */
    showOrigin?: boolean;
    /** 封面 URL 覆盖（父级显式传入；空串表示暂无可用 URL） */
    coverUrl?: string;
    /** 封面仍在代理解析中：显示占位，不显示默认封面 */
    coverPending?: boolean;
    /** 外部强制显示默认封面（书架重试失败后） */
    forceDefaultCover?: boolean;
  }>(),
  { showOrigin: true, coverPending: false },
);

const emit = defineEmits<{
  click: [item: SearchBookItem];
  coverError: [item: SearchBookItem];
}>();

const { findBookshelfBook } = useFindBookBookshelf();

const coverLoadFailed = ref(false);

/**
 * `coverUrl` 由父级显式传入时（含空串）以父级为准，勿回退到可能已失效的 item.coverUrl。
 * 未传该 prop 时再用 item.coverUrl。
 */
const displayCoverUrl = computed(() => {
  if (props.coverUrl !== undefined) {
    const t = props.coverUrl.trim();
    return t || undefined;
  }
  return props.item.coverUrl?.trim() || undefined;
});

const introText = computed(() => formatBookIntroForDisplay(props.item.intro));

const kindTags = computed(() => getBookKindList(props.item));

/** 仅最终失败才用默认封面；解析中用占位 */
const showDefaultCover = computed(
  () =>
    props.forceDefaultCover ||
    coverLoadFailed.value ||
    (!props.coverPending && !displayCoverUrl.value),
);

const showCoverPending = computed(
  () =>
    !showDefaultCover.value &&
    !displayCoverUrl.value &&
    props.coverPending,
);

const shelfBook = computed(() =>
  findBookshelfBook(props.item.bookUrl, props.item.origin),
);

/** 已在书架且已读至最新 → 成功角标；否则书架角标 */
const coverBadge = computed((): "caughtUp" | "onShelf" | null => {
  const shelf = shelfBook.value;
  if (!shelf) return null;
  if (isBookshelfCaughtUpToLatest(shelf)) {
    return "caughtUp";
  }
  return "onShelf";
});

watch(
  () => [props.coverUrl, props.item.coverUrl, props.item.id] as const,
  () => {
    coverLoadFailed.value = false;
  },
);

function onClick() {
  emit("click", props.item);
}

function onCoverError() {
  coverLoadFailed.value = true;
  emit("coverError", props.item);
}

function onCoverLoad(e: Event) {
  const img = e.target as HTMLImageElement;
  if (!img.naturalWidth || !img.naturalHeight) onCoverError();
}
</script>

<template>
  <li class="findBookListItem" @click="onClick">
    <span
      v-if="coverBadge === 'caughtUp'"
      class="findBookCoverBadge findBookCoverBadge--caughtUp"
      title="已读至最新章节"
      aria-label="已读至最新章节"
      v-html="icons.ok"
    />
    <span
      v-else-if="coverBadge === 'onShelf'"
      class="findBookCoverBadge findBookCoverBadge--onShelf"
      title="已在书架"
      aria-label="已在书架"
      v-html="icons.bookshelf"
    />
    <div class="findBookListItemCoverWrap">
      <DefaultBookCover
        v-if="showDefaultCover"
        class="findBookListItemCover"
        :title="item.name"
        :author="item.author"
      />
      <div
        v-else-if="showCoverPending"
        class="findBookListItemCover findBookListItemCover--pending"
        aria-hidden="true"
      />
      <img
        v-else
        class="findBookListItemCover"
        :src="displayCoverUrl"
        alt=""
        loading="lazy"
        referrerpolicy="no-referrer"
        @error="onCoverError"
        @load="onCoverLoad"
      />
    </div>
    <div class="findBookListItemMain">
      <div v-if="showOrigin" class="findBookListItemHead">
        <div class="findBookListItemTitle">{{ item.name }}</div>
        <div v-if="item.originName" class="findBookListItemOrigin">
          {{ item.originName }}
        </div>
      </div>
      <div v-else class="findBookListItemTitle">{{ item.name }}</div>
      <div class="findBookListItemAuthor">{{ formatBookAuthor(item.author) }}</div>
      <div v-if="kindTags.length" class="findBookListItemTags">
        <span
          v-for="(tag, tagIdx) in kindTags"
          :key="`${item.id}-tag-${tagIdx}`"
          class="findBookListItemTag"
        >{{ tag }}</span>
      </div>
      <div v-if="item.lastChapter" class="findBookListItemLatest">
        最新：{{ item.lastChapter }}
      </div>
      <div
        v-if="introText"
        class="findBookListItemIntro"
        :title="introText"
      >{{ introText }}</div>
    </div>
  </li>
</template>

<style scoped>
.findBookListItem {
  position: relative;
  display: flex;
  gap: 10px;
  padding: 10px;
  border-radius: 8px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  color: var(--fg);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
}
.findBookListItem:hover {
  box-shadow: 0 2px 8px color-mix(in srgb, var(--fg) 12%, transparent);
}
.findBookListItemCoverWrap {
  flex-shrink: 0;
  width: 76px;
  height: 102px;
}
.findBookListItemCover {
  width: 76px;
  height: 102px;
  border-radius: 4px;
  flex-shrink: 0;
  display: block;
}
.findBookCoverBadge {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 3px 0 0 3px;
  border-radius: 7px 0 0 0;
  clip-path: polygon(0 0, 100% 0, 0 100%);
  color: #fff;
  pointer-events: none;
  user-select: none;
}
.findBookCoverBadge--caughtUp {
  background: var(--success);
}
.findBookCoverBadge--onShelf {
  background: var(--accent);
}
.findBookCoverBadge :deep(svg) {
  width: 11px;
  height: 11px;
  display: block;
}
.findBookCoverBadge :deep(svg path) {
  fill: currentColor;
}
img.findBookListItemCover {
  object-fit: cover;
  background: var(--scrollbar-track);
}
.findBookListItemMain {
  flex: 1;
  min-width: 0;
}
.findBookListItemHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.findBookListItemTitle {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 15px;
  line-height: 1.35;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}
.findBookListItemHead .findBookListItemTitle {
  margin-bottom: 0;
}
.findBookListItemOrigin {
  flex-shrink: 0;
  max-width: 42%;
  font-size: 11px;
  line-height: 1.45;
  color: var(--book-source, var(--find-book-origin, #7c5cbf));
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.findBookListItemAuthor {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 6px;
}
.findBookListItemTags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.findBookListItemTag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.4;
  background: color-mix(in srgb, var(--accent) 12%, var(--btn-bg, rgba(0, 0, 0, 0.06)));
  color: var(--fg);
}
.findBookListItemLatest {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.findBookListItemIntro {
  font-size: 12px;
  line-height: 1.45;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
}
</style>
