<script setup lang="ts">
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";

definePageMeta({ auth: false });

const { signIn } = useAuth();
</script>

<template>
  <NuxtLayout>
    <div class="flex justify-center my-4">
      <button
        class="bg-discord hover:bg-discord/80 p-2 rounded text-sm/6 font-semibold text-gray-100"
        type="button"
        @click="signIn('discord', { callbackUrl: '/' })"
      >
        <font-awesome-icon :icon="['fab', 'discord']" class="mr-2" />
        Log in with Discord
      </button>
    </div>
  </NuxtLayout>
</template>
