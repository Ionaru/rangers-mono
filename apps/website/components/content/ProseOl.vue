<template>
  <ol>
    <slot />
  </ol>
</template>
<style lang="postcss">
ol {
  @apply list-decimal list-outside;
}

li ol {
  padding-inline-start: 1em;
  @apply mb-0;

  ol {
    padding-inline-start: 2em;

    ol {
      padding-inline-start: 3em;
    }
  }
}
</style>
