<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

type ContextMenuItem = {
  id: string;
  label?: string;
  type?: "primary" | "success" | "warning" | "danger";
  separator?: boolean;
  disabled?: boolean;
  /** 与 `icons.*` 一致，渲染在标签左侧 */
  iconHtml?: string;
};

const props = withDefaults(
  defineProps<{
    open: boolean;
    x: number;
    y: number;
    items: readonly ContextMenuItem[];
    minWidth?: number;
    /** 点击落点在此元素内时不视为“外部点击”，不自动关闭（用于锚点按钮触发的菜单） */
    excludeCloseWithin?: HTMLElement | null;
    /**
     * `point`：以 (x,y) 为左上角（经视口夹取）。
     * `aboveFooterMouseX`：菜单在底栏上方弹出（底边不盖住底栏），水平以 `pointerXPx` 居中对齐后再夹到视口内。
     */
    placement?: "point" | "aboveFooterMouseX";
    /** `placement === 'aboveFooterMouseX'` 时：底栏 `getBoundingClientRect().top` */
    footerTopPx?: number | null;
    /** `placement === 'aboveFooterMouseX'` 时：打开菜单时的指针 `clientX` */
    pointerXPx?: number | null;
  }>(),
  {
    placement: "point",
    footerTopPx: null,
    pointerXPx: null,
    excludeCloseWithin: undefined,
  },
);

const emit = defineEmits<{
  close: [];
  select: [id: string];
}>();

const menuRef = ref<HTMLElement | null>(null);
const posX = ref(0);
const posY = ref(0);

function itemClass(item: ContextMenuItem) {
  const c = ["appShellMenuItem"];
  if (item.type) c.push(`appShellMenuItem--${item.type}`);
  return c.join(" ");
}

function onMenuItemClick(item: ContextMenuItem) {
  if (item.disabled) return;
  emit("select", item.id);
}

function clampPosition() {
  const menu = menuRef.value;
  if (!menu) return;
  const margin = 8;
  const gapAboveAnchor = 4;
  const maxX = Math.max(margin, window.innerWidth - menu.offsetWidth - margin);
  const maxY = Math.max(
    margin,
    window.innerHeight - menu.offsetHeight - margin,
  );

  if (
    props.placement === "aboveFooterMouseX" &&
    props.footerTopPx != null &&
    props.pointerXPx != null
  ) {
    const footerTop = props.footerTopPx;
    const xIdeal = props.pointerXPx - menu.offsetWidth / 2;
    posX.value = Math.min(Math.max(margin, xIdeal), maxX);
    const ymaxFoot = footerTop - gapAboveAnchor - menu.offsetHeight;
    posY.value = Math.min(
      Math.max(margin, ymaxFoot),
      Math.min(maxY, ymaxFoot),
    );
    return;
  }

  posX.value = Math.min(Math.max(margin, props.x), maxX);
  posY.value = Math.min(Math.max(margin, props.y), maxY);
}

watch(
  () =>
    [
      props.open,
      props.x,
      props.y,
      props.placement,
      props.footerTopPx,
      props.pointerXPx,
    ] as const,
  async ([open]) => {
    if (!open) return;
    if (props.placement === "point") {
      posX.value = props.x;
      posY.value = props.y;
    }
    await nextTick();
    clampPosition();
  },
);

function onDocPointerDown(ev: PointerEvent) {
  if (!props.open) return;
  const t = ev.target as Node | null;
  if (t && menuRef.value?.contains(t)) return;
  if (
    t &&
    props.excludeCloseWithin &&
    props.excludeCloseWithin.contains(t as Node)
  ) {
    return;
  }
  emit("close");
}

function onWindowInvalidate() {
  if (!props.open) return;
  emit("close");
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  window.addEventListener("resize", onWindowInvalidate);
  window.addEventListener("blur", onWindowInvalidate);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  window.removeEventListener("resize", onWindowInvalidate);
  window.removeEventListener("blur", onWindowInvalidate);
});
</script>

<template>
  <div
    v-if="open"
    ref="menuRef"
    class="contextMenu appShellMenuPanel"
    role="menu"
    :style="{
      left: `${posX}px`,
      top: `${posY}px`,
      minWidth: `${minWidth ?? 140}px`,
    }"
    @click.stop
  >
    <template v-for="item in items" :key="item.id">
      <div v-if="item.separator" class="appShellMenuDivider" role="separator" />
      <button
        v-else
        type="button"
        :class="itemClass(item)"
        role="menuitem"
        :disabled="item.disabled"
        @click="onMenuItemClick(item)"
      >
        <span
          v-if="item.iconHtml"
          class="appShellMenuItemPrefix"
          aria-hidden="true"
          v-html="item.iconHtml"
        />
        {{ item.label }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.contextMenu {
  position: fixed;
  z-index: 7000;
}

.contextMenu :deep(.appShellMenuItemPrefix svg path) {
  fill: currentColor;
}
</style>
