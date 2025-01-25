const axios = require("axios");
const https = require("https");

const agent = new https.Agent({
  maxSockets: 250,
});

const axiosObject = axios.create({
  httpsAgent: agent,
});

module.exports = {
  async axiosFetchWithRetries ( input, init, retryAttempts = 0) {
    let attempt = 0;

    // Adding default headers
    if (!init || !init.headers) {
      init = {
        headers: {
          "Content-Type": "application/json",
        },
        ...init,
      };
    }

    while (attempt < retryAttempts) {
      try {
        let axiosHeaders = {};

        axiosHeaders = Array.from(new Headers(init.headers).entries()).reduce(
          (acc, [key, value]) => {
            acc[key] = value;
            return acc;
          },
          {}
        );

        const axiosConfig = {
          data: init.body,
          headers: axiosHeaders,
          method: init.method,
          baseURL: input.toString(),
          validateStatus: (status) => true,
        };

        const axiosResponse = await axiosObject.request(axiosConfig);

        const { data, status, statusText, headers } = axiosResponse;

        // Mapping headers from axios to fetch format
        const headersArray = Object.entries(headers).map(
          ([key, value]) => [key, value]
        );

        const fetchHeaders = new Headers(headersArray);

        const response = new Response(JSON.stringify(data), {
          status,
          statusText,
          headers: fetchHeaders,
        });

        // when it throws a 502, retry
        if (response.status === 502) {
          console.log("Retrying due to 502");

          attempt++;

          // Backoff to avoid hammering the server
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * attempt)
          );

          continue;
        }
        return Promise.resolve(response);
      } catch (e) {
        console.log(`Retrying due to error ${e}`, e);

        attempt++;
        continue;
      }
    }
    return Promise.reject("Max retries reached");
  }
};
