<template>
  <div class="table-toolbar">
    <div class="table-filters">
      <slot />
    </div>
    <div class="table-toolbar-actions">
      <slot name="actions" />
    </div>
  </div>
</template>
