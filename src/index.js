import homepage from "../index.html";

export default {
  async fetch(request, env, ctx) {
    return new Response(homepage, {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
      },
    });
  },
};
