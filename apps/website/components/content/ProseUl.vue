<template>
  <ul class="list-disc list-inside mb-4">
    <slot />
  </ul>
</template>
<style lang="postcss" scoped>
ul ul {
  list-style-type: circle;
  padding-inline-start: 1em;
  @apply mb-0;

  ul {
    list-style-type: square;
    padding-inline-start: 2em;

    ul {
      list-style-type: disc;
      padding-inline-start: 3em;
    }
  }
}
</style>
