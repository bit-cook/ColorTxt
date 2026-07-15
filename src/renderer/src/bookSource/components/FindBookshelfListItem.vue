<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DefaultBookCover from "./DefaultBookCover.vue";
import AppCheckbox from "../../components/AppCheckbox.vue";
import type { BookshelfBook } from "../findBookBookshelf";
import { formatBookAuthor } from "../bookSourceDisplay";
import {
  formatBookshelfLastRead,
  formatBookshelfLatestChapter,
  isBookshelfCaughtUpToLatest,
  isBookshelfLastReadChapterVip,
  isBookshelfLatestChapterVip,
} from "../findBookshelfDisplay";
import { SORTABLE_ROW_HANDLE_CLASS } from "../../composables/useSortableReorder";
import { icons } from "../../icons";
import RefreshIcon from "../../components/RefreshIcon.vue";

const props = withDefaults(
  defineProps<{
    item: BookshelfBook;
    coverUrl?: string;
    /** 封面仍在代理解析中：显示占位，不显示默认封面 */
    coverPending?: boolean;
    forceDefaultCover?: boolean;
    /** 最后阅读展示（含异步解析的章节名） */
    lastReadText?: string;
    /** 手动排序模式下显示拖动手柄 */
    showDragHandle?: boolean;
    /** 正在更新书籍信息 */
    updating?: boolean;
    /** 书架管理（编辑）模式 */
    managing?: boolean;
    /** 编辑模式下是否选中 */
    selected?: boolean;
  }>(),
  {
    coverPending: false,
    showDragHandle: false,
    updating: false,
    managing: false,
    selected: false,
  },
);

const emit = defineEmits<{
  click: [item: BookshelfBook];
  coverError: [item: BookshelfBook];
  more: [item: BookshelfBook, event: MouseEvent];
  remove: [item: BookshelfBook];
}>();

const coverLoadFailed = ref(false);

const displayCoverUrl = computed(() => {
  if (props.coverUrl !== undefined) {
    const t = props.coverUrl.trim();
    return t || undefined;
  }
  return props.item.coverUrl?.trim() || undefined;
});

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

const latestChapterText = computed(() => formatBookshelfLatestChapter(props.item));
const lastReadText = computed(
  () => props.lastReadText ?? formatBookshelfLastRead(props.item),
);
const caughtUpToLatest = computed(() =>
  isBookshelfCaughtUpToLatest(props.item, lastReadText.value),
);
const latestChapterVip = computed(() => isBookshelfLatestChapterVip(props.item));
const lastReadChapterVip = computed(() =>
  isBookshelfLastReadChapterVip(props.item),
);
const updateDisabled = computed(() => props.item.canUpdate === false);

watch(
  () => props.coverUrl,
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

function onMoreClick(e: MouseEvent) {
  emit("more", props.item, e);
}

function onRemoveClick(e: MouseEvent) {
  e.stopPropagation();
  emit("remove", props.item);
}
</script>

<template>
  <li
    class="findBookListItem"
    :class="{
      'findBookListItem--selected': managing && selected,
      'findBookListItem--managing': managing,
    }"
    @click="onClick"
  >
    <span
      v-if="caughtUpToLatest"
      class="findBookshelfCaughtUpBadge"
      title="已读至最新章节"
      aria-label="已读至最新章节"
      v-html="icons.ok"
    />
    <AppCheckbox
      v-if="managing"
      class="findBookshelfSelectCheckbox"
      passive
      :model-value="selected"
      :aria-label="`选择 ${item.name}`"
    />
    <div class="findBookshelfCoverWrap">
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
    <div
      class="findBookListItemMain"
      :class="{ 'findBookListItemMain--managing': managing }"
    >
      <div class="findBookListItemBody">
        <div class="findBookListItemTitle">{{ item.name }}</div>
        <div class="findBookListItemAuthor">{{ formatBookAuthor(item.author) }}</div>
        <div class="findBookListItemLatest">
          最新章节：<span
            v-if="latestChapterVip"
            class="findBookshelfChapterLock"
            v-html="icons.lock"
            aria-hidden="true"
          /><span :title="latestChapterText">{{ latestChapterText }}</span>
        </div>
        <div class="findBookListItemLatest">
          最后阅读：<span
            v-if="lastReadChapterVip"
            class="findBookshelfChapterLock"
            v-html="icons.lock"
            aria-hidden="true"
          /><span :title="lastReadText">{{ lastReadText }}</span>
        </div>
        <div v-if="item.originName" class="findBookListItemOrigin">{{ item.originName }}</div>
      </div>
      <div v-if="!managing" class="findBookListItemActions">
        <button
          v-if="showDragHandle"
          type="button"
          class="findBookshelfDragHandle"
          :class="SORTABLE_ROW_HANDLE_CLASS"
          aria-label="拖动排序"
          title="拖动排序"
          @click.stop
        >
          <span
            class="findBookshelfDragHandleIcon"
            aria-hidden="true"
            v-html="icons.move"
          />
        </button>
        <button
          type="button"
          class="findBookshelfMoreBtn"
          aria-label="更多"
          title="更多"
          @click.stop="onMoreClick"
        >
          <span
            class="findBookshelfMoreBtnIcon"
            aria-hidden="true"
            v-html="icons.more"
          />
        </button>
      </div>
      <div v-if="managing && updateDisabled" class="findBookListItemMeta">
        <span class="findBookshelfStatusTag">已禁止更新</span>
      </div>
    </div>
    <button
      v-if="managing"
      type="button"
      class="findBookshelfRemoveBtn"
      aria-label="移除"
      title="移除"
      @click="onRemoveClick"
    >
      <span class="findBookshelfRemoveBtnIcon" aria-hidden="true" v-html="icons.remove" />
    </button>
    <div
      v-else-if="updating || updateDisabled"
      class="findBookshelfStatus"
    >
      <RefreshIcon
        v-if="updating"
        class="findBookshelfStatusIcon"
        :size="16"
        spinning
      />
      <span v-else-if="updateDisabled" class="findBookshelfStatusTag">已禁止更新</span>
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
.findBookListItem--selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}
.findBookListItem--selected:hover {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent),
    0 2px 8px color-mix(in srgb, var(--fg) 12%, transparent);
}
.findBookshelfSelectCheckbox {
  flex-shrink: 0;
  align-self: center;
  margin: 0;
}
.findBookListItemActions {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.findBookshelfDragHandle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  opacity: 0;
  pointer-events: none;
  cursor: grab;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}
.findBookListItem:hover .findBookshelfDragHandle,
.findBookListItem.sortableRowChosen .findBookshelfDragHandle {
  opacity: 1;
  pointer-events: auto;
}
.findBookshelfDragHandle:hover {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  color: var(--fg);
}
.findBookshelfDragHandleIcon {
  display: flex;
  width: 16px;
  height: 16px;
}
.findBookshelfDragHandleIcon :deep(svg) {
  width: 16px;
  height: 16px;
  display: block;
}
.findBookshelfDragHandleIcon :deep(svg path) {
  fill: currentColor;
}
.findBookshelfCoverWrap {
  position: relative;
  flex-shrink: 0;
  width: 76px;
  height: 102px;
}
.findBookListItemCover {
  width: 76px;
  height: 102px;
  border-radius: 4px;
  flex-shrink: 0;
}
.findBookshelfCaughtUpBadge {
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
  background: var(--success);
  clip-path: polygon(0 0, 100% 0, 0 100%);
  color: #fff;
  pointer-events: none;
  user-select: none;
}
.findBookshelfCaughtUpBadge :deep(svg) {
  width: 11px;
  height: 11px;
  display: block;
}
.findBookshelfCaughtUpBadge :deep(svg path) {
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
.findBookListItemMain--managing {
  display: flex;
  align-items: stretch;
  gap: 10px;
}
.findBookListItemBody {
  flex: 1;
  min-width: 0;
}
.findBookListItemMeta {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: flex-end;
  min-width: 0;
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
  margin-bottom: 4px;
}
.findBookListItemOrigin {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--book-source, var(--find-book-origin, #7c5cbf));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.findBookshelfMoreBtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--muted);
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}
.findBookListItem:hover .findBookshelfMoreBtn {
  opacity: 1;
  pointer-events: auto;
}
.findBookshelfMoreBtn:hover {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  color: var(--fg);
}
.findBookshelfMoreBtnIcon {
  display: flex;
  width: 16px;
  height: 16px;
}
.findBookshelfMoreBtnIcon :deep(svg) {
  width: 16px;
  height: 16px;
  display: block;
}
.findBookshelfMoreBtnIcon :deep(svg path) {
  fill: currentColor;
}
.findBookshelfRemoveBtn {
  flex-shrink: 0;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.findBookshelfRemoveBtn:hover {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}
.findBookshelfRemoveBtnIcon {
  display: flex;
  width: 16px;
  height: 16px;
}
.findBookshelfRemoveBtnIcon :deep(svg) {
  width: 16px;
  height: 16px;
  display: block;
}
.findBookshelfRemoveBtnIcon :deep(svg path) {
  fill: currentColor;
}
.findBookshelfStatus {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 2;
  pointer-events: none;
}
.findBookshelfStatusIcon {
  color: var(--muted);
}
.findBookshelfStatusTag {
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 1.3;
  color: var(--muted);
  background: color-mix(in srgb, var(--fg) 6%, var(--surface-elevated));
  white-space: nowrap;
}
.findBookListItemAuthor {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 6px;
}
.findBookListItemLatest {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.findBookshelfChapterLock {
  display: inline-flex;
  align-items: center;
  vertical-align: -0.15em;
  margin-right: 4px;
  color: var(--warning);
}
.findBookshelfChapterLock :deep(svg) {
  width: 12px;
  height: 12px;
  display: block;
}
.findBookshelfChapterLock :deep(svg path) {
  fill: currentColor;
}
.findBookListItemLatest:last-child {
  margin-bottom: 0;
}
</style>
