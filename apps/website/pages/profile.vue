<script setup lang="ts">
const { data, signOut } = useAuth();
</script>

<template>
  <NuxtLayout>
    <div class="flex flex-col items-center my-4">
      <p>Logged in as: {{ data?.user?.name }}</p>
      <button @click="signOut({ external: false, callbackUrl: '/' })">
        Log out
      </button>
    </div>
  </NuxtLayout>
</template>
