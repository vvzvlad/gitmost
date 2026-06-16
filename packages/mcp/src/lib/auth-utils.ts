import axios from "axios";

export async function getCollabToken(
  baseUrl: string,
  apiToken: string,
): Promise<string> {
  try {
    const response = await axios.post(
      `${baseUrl}/auth/collab-token`,
      {},
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    // console.error('Collab Token Response:', response.data);
    // Response is wrapped in { data: { token: ... } }
    return response.data.data?.token || response.data.token;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      // Attach the HTTP status to the plain Error so callers (e.g.
      // getCollabTokenWithReauth) can still detect a 401/403 after the
      // original AxiosError has been wrapped away.
      // Avoid leaking the full server response body by default; include only
      // status + statusText. Append the body only when DEBUG is set.
      let message = `Failed to get collab token: ${error.response?.status} ${error.response?.statusText}`;
      if (process.env.DEBUG) {
        message += ` - ${JSON.stringify(error.response?.data)}`;
      }
      const err: any = new Error(message);
      err.status = error.response?.status;
      throw err;
    }
    throw error;
  }
}

export async function performLogin(
  baseUrl: string,
  email: string,
  password: string,
): Promise<string> {
  try {
    const response = await axios.post(`${baseUrl}/auth/login`, {
      email,
      password,
    });

    // Extract token from Set-Cookie header
    const cookies = response.headers["set-cookie"];
    if (!cookies) {
      throw new Error("No Set-Cookie header found in login response");
    }
    // Match the cookie name exactly to avoid matching a future
    // authTokenRefresh cookie (startsWith would catch it).
    const authCookie = cookies.find((c: string) => {
      const kv = c.split(";")[0];
      return kv.slice(0, kv.indexOf("=")) === "authToken";
    });
    if (!authCookie) {
      throw new Error("No authToken cookie found in login response");
    }

    // Take everything after the FIRST "=" up to the first ";".
    // Splitting on "=" would truncate base64 values containing "=" padding.
    const kv = authCookie.split(";")[0];
    const token = kv.slice(kv.indexOf("=") + 1);
    return token;
  } catch (error: any) {
    // Avoid leaking the full server response body by default; log only the
    // HTTP status. Log the verbose body only when DEBUG is set.
    if (axios.isAxiosError(error)) {
      if (process.env.DEBUG) {
        console.error("Login failed:", error.response?.data);
      } else {
        console.error("Login failed:", error.response?.status);
      }
    } else {
      console.error("Login failed:", error.message);
    }
    throw error;
  }
}
