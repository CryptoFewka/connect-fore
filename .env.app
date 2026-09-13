# The "app" build target. Selected with `vite build --mode app`.
#
# A bundled app cannot derive the server from the page: inside the shell the
# origin is capacitor://localhost. The web target leaves this unset on purpose
# and keeps using the page origin, which is what Cloudflare deploys.
#
# A real VITE_API_ORIGIN in the environment overrides this file, so CI can aim
# an app build at staging without editing anything here.
VITE_API_ORIGIN=https://fore.automa.agency
