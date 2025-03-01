const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const { exec, spawn } = require("child_process");
const tcpPortUsed = require("tcp-port-used");
const fetchRetry = require("fetch-retry")(global.fetch);
const osUtils = require("os-utils");
const { readFileSync, writeFileSync, existsSync } = require("fs");

// The PORT to use for the Nitro subprocess
const PORT = 3928;
const LOCAL_HOST = "127.0.0.1";
const NITRO_HTTP_SERVER_URL = `http://${LOCAL_HOST}:${PORT}`;
const NITRO_HTTP_LOAD_MODEL_URL = `${NITRO_HTTP_SERVER_URL}/inferences/llamacpp/loadmodel`;
const NITRO_HTTP_UNLOAD_MODEL_URL = `${NITRO_HTTP_SERVER_URL}/inferences/llamacpp/unloadModel`;
const NITRO_HTTP_VALIDATE_MODEL_URL = `${NITRO_HTTP_SERVER_URL}/inferences/llamacpp/modelstatus`;
const NITRO_HTTP_KILL_URL = `${NITRO_HTTP_SERVER_URL}/processmanager/destroy`;
const SUPPORTED_MODEL_FORMAT = ".gguf";
const NVIDIA_INFO_FILE = path.join(
  require("os").homedir(),
  "jan",
  "settings",
  "settings.json"
);

const DEFALT_SETTINGS = {
  "notify": true,
  "run_mode": "cpu",
  "nvidia_driver": {
    "exist": false,
    "version": ""
  },
  "cuda": {
    "exist": false,
    "version": ""
  },
  "gpus": [],
  "gpu_highest_vram": ""
}

// The subprocess instance for Nitro
let subprocess = undefined;
let currentModelFile: string = undefined;
let currentSettings = undefined;

/**
 * Stops a Nitro subprocess.
 * @param wrapper - The model wrapper.
 * @returns A Promise that resolves when the subprocess is terminated successfully, or rejects with an error message if the subprocess fails to terminate.
 */
function stopModel(): Promise<void> {
  return killSubprocess();
}

/**
 * Validate nvidia and cuda for linux and windows
 */
async function updateNvidiaDriverInfo(): Promise<void> {
  exec(
    "nvidia-smi --query-gpu=driver_version --format=csv,noheader",
    (error, stdout) => {
      let data;
      try {
        data = JSON.parse(readFileSync(NVIDIA_INFO_FILE, "utf8"));
      } catch (error) {
        data = DEFALT_SETTINGS;
      }

      if (!error) {
        const firstLine = stdout.split("\n")[0].trim();
        data["nvidia_driver"].exist = true;
        data["nvidia_driver"].version = firstLine;
      } else {
        data["nvidia_driver"].exist = false;
      }

      writeFileSync(NVIDIA_INFO_FILE, JSON.stringify(data, null, 2));
      Promise.resolve();
    }
  );
}

function checkFileExistenceInPaths(file: string, paths: string[]): boolean {
  return paths.some((p) => existsSync(path.join(p, file)));
}

function updateCudaExistence() {
  let files: string[];
  let paths: string[];

  if (process.platform === "win32") {
    files = ["cublas64_12.dll", "cudart64_12.dll", "cublasLt64_12.dll"];
    paths = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
    const nitro_cuda_path = path.join(__dirname, "bin", "win-cuda");
    paths.push(nitro_cuda_path);
  } else {
    files = ["libcudart.so.12", "libcublas.so.12", "libcublasLt.so.12"];
    paths = process.env.LD_LIBRARY_PATH
      ? process.env.LD_LIBRARY_PATH.split(path.delimiter)
      : [];
    const nitro_cuda_path = path.join(__dirname, "bin", "linux-cuda");
    paths.push(nitro_cuda_path);
    paths.push("/usr/lib/x86_64-linux-gnu/");
  }

  let cudaExists = files.every(
    (file) => existsSync(file) || checkFileExistenceInPaths(file, paths)
  );

  let data;
  try {
    data = JSON.parse(readFileSync(NVIDIA_INFO_FILE, "utf8"));
  } catch (error) {
    data = DEFALT_SETTINGS;
  }

  data["cuda"].exist = cudaExists;
  if (cudaExists) {
    data.run_mode = "gpu";
  }
  writeFileSync(NVIDIA_INFO_FILE, JSON.stringify(data, null, 2));
}

async function updateGpuInfo(): Promise<void> {
  exec(
    "nvidia-smi --query-gpu=index,memory.total --format=csv,noheader,nounits",
    (error, stdout) => {
      let data;
      try {
        data = JSON.parse(readFileSync(NVIDIA_INFO_FILE, "utf8"));
      } catch (error) {
        data = DEFALT_SETTINGS;
      }

      if (!error) {
        // Get GPU info and gpu has higher memory first
        let highestVram = 0;
        let highestVramId = "0";
        let gpus = stdout
          .trim()
          .split("\n")
          .map((line) => {
            let [id, vram] = line.split(", ");
            vram = vram.replace(/\r/g, "");
            if (parseFloat(vram) > highestVram) {
              highestVram = parseFloat(vram);
              highestVramId = id;
            }
            return { id, vram };
          });

        data["gpus"] = gpus;
        data["gpu_highest_vram"] = highestVramId;
      } else {
        data["gpus"] = [];
      }

      writeFileSync(NVIDIA_INFO_FILE, JSON.stringify(data, null, 2));
      Promise.resolve();
    }
  );
}

async function updateNvidiaInfo() {
  if (process.platform !== "darwin") {
    await Promise.all([
      updateNvidiaDriverInfo(),
      updateCudaExistence(),
      updateGpuInfo(),
    ]);
  }
}

/**
 * Initializes a Nitro subprocess to load a machine learning model.
 * @param wrapper - The model wrapper.
 * @returns A Promise that resolves when the model is loaded successfully, or rejects with an error message if the model is not found or fails to load.
 * TODO: Should pass absolute of the model file instead of just the name - So we can modurize the module.ts to npm package
 * TODO: Should it be startModel instead?
 */
async function initModel(wrapper: any): Promise<ModelOperationResponse> {
  currentModelFile = wrapper.modelFullPath;
  const janRoot = path.join(require("os").homedir(), "jan");
  if (!currentModelFile.includes(janRoot)) {
    currentModelFile = path.join(janRoot, currentModelFile);
  }
  const files: string[] = fs.readdirSync(currentModelFile);

  // Look for GGUF model file
  const ggufBinFile = files.find(
    (file) =>
      file === path.basename(currentModelFile) ||
      file.toLowerCase().includes(SUPPORTED_MODEL_FORMAT)
  );

  currentModelFile = path.join(currentModelFile, ggufBinFile);

  if (wrapper.model.engine !== "nitro") {
    return Promise.resolve({ error: "Not a nitro model" });
  } else {
    const nitroResourceProbe = await getResourcesInfo();
    // Convert settings.prompt_template to system_prompt, user_prompt, ai_prompt
    if (wrapper.model.settings.prompt_template) {
      const promptTemplate = wrapper.model.settings.prompt_template;
      const prompt = promptTemplateConverter(promptTemplate);
      if (prompt.error) {
        return Promise.resolve({ error: prompt.error });
      }
      wrapper.model.settings.system_prompt = prompt.system_prompt;
      wrapper.model.settings.user_prompt = prompt.user_prompt;
      wrapper.model.settings.ai_prompt = prompt.ai_prompt;
    }

    currentSettings = {
      llama_model_path: currentModelFile,
      ...wrapper.model.settings,
      // This is critical and requires real system information
      cpu_threads: nitroResourceProbe.numCpuPhysicalCore,
    };
    return loadModel(nitroResourceProbe);
  }
}

async function loadModel(nitroResourceProbe: any | undefined) {
  // Gather system information for CPU physical cores and memory
  if (!nitroResourceProbe) nitroResourceProbe = await getResourcesInfo();
  return (
    killSubprocess()
      .then(() => tcpPortUsed.waitUntilFree(PORT, 300, 5000))
      // wait for 500ms to make sure the port is free for windows platform
      .then(() => {
        if (process.platform === "win32") {
          return sleep(500);
        } else {
          return sleep(0);
        }
      })
      .then(() => spawnNitroProcess(nitroResourceProbe))
      .then(() => loadLLMModel(currentSettings))
      .then(validateModelStatus)
      .catch((err) => {
        console.error("error: ", err);
        // TODO: Broadcast error so app could display proper error message
        return { error: err, currentModelFile };
      })
  );
}

// Add function sleep
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptTemplateConverter(promptTemplate) {
  // Split the string using the markers
  const systemMarker = "{system_message}";
  const promptMarker = "{prompt}";

  if (
    promptTemplate.includes(systemMarker) &&
    promptTemplate.includes(promptMarker)
  ) {
    // Find the indices of the markers
    const systemIndex = promptTemplate.indexOf(systemMarker);
    const promptIndex = promptTemplate.indexOf(promptMarker);

    // Extract the parts of the string
    const system_prompt = promptTemplate.substring(0, systemIndex);
    const user_prompt = promptTemplate.substring(
      systemIndex + systemMarker.length,
      promptIndex
    );
    const ai_prompt = promptTemplate.substring(
      promptIndex + promptMarker.length
    );

    // Return the split parts
    return { system_prompt, user_prompt, ai_prompt };
  } else if (promptTemplate.includes(promptMarker)) {
    // Extract the parts of the string for the case where only promptMarker is present
    const promptIndex = promptTemplate.indexOf(promptMarker);
    const user_prompt = promptTemplate.substring(0, promptIndex);
    const ai_prompt = promptTemplate.substring(
      promptIndex + promptMarker.length
    );
    const system_prompt = "";

    // Return the split parts
    return { system_prompt, user_prompt, ai_prompt };
  }

  // Return an error if none of the conditions are met
  return { error: "Cannot split prompt template" };
}

/**
 * Loads a LLM model into the Nitro subprocess by sending a HTTP POST request.
 * @returns A Promise that resolves when the model is loaded successfully, or rejects with an error message if the model is not found or fails to load.
 */
function loadLLMModel(settings): Promise<Response> {
  return fetchRetry(NITRO_HTTP_LOAD_MODEL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
    retries: 3,
    retryDelay: 500,
  });
}

/**
 * Validates the status of a model.
 * @returns {Promise<ModelOperationResponse>} A promise that resolves to an object.
 * If the model is loaded successfully, the object is empty.
 * If the model is not loaded successfully, the object contains an error message.
 */
async function validateModelStatus(): Promise<ModelOperationResponse> {
  // Send a GET request to the validation URL.
  // Retry the request up to 3 times if it fails, with a delay of 500 milliseconds between retries.
  return fetchRetry(NITRO_HTTP_VALIDATE_MODEL_URL, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
    retries: 5,
    retryDelay: 500,
  }).then(async (res: Response) => {
    // If the response is OK, check model_loaded status.
    if (res.ok) {
      const body = await res.json();
      // If the model is loaded, return an empty object.
      // Otherwise, return an object with an error message.
      if (body.model_loaded) {
        return { error: undefined };
      }
    }
    return { error: "Model loading failed" };
  });
}

/**
 * Terminates the Nitro subprocess.
 * @returns A Promise that resolves when the subprocess is terminated successfully, or rejects with an error message if the subprocess fails to terminate.
 */
async function killSubprocess(): Promise<void> {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5000);
  console.debug("Start requesting to kill Nitro...");
  return fetch(NITRO_HTTP_KILL_URL, {
    method: "DELETE",
    signal: controller.signal,
  })
    .then(() => {
      subprocess?.kill();
      subprocess = undefined;
    })
    .catch(() => {})
    .then(() => tcpPortUsed.waitUntilFree(PORT, 300, 5000))
    .then(() => console.debug("Nitro is killed"));
}
/**
 * Look for the Nitro binary and execute it
 * Using child-process to spawn the process
 * Should run exactly platform specified Nitro binary version
 */
/**
 * Spawns a Nitro subprocess.
 * @param nitroResourceProbe - The Nitro resource probe.
 * @returns A promise that resolves when the Nitro subprocess is started.
 */
function spawnNitroProcess(nitroResourceProbe: any): Promise<any> {
  console.debug("Starting Nitro subprocess...");
  return new Promise(async (resolve, reject) => {
    let binaryFolder = path.join(__dirname, "bin"); // Current directory by default
    let cudaVisibleDevices = "";
    let binaryName;
    if (process.platform === "win32") {
      let nvida_info = JSON.parse(readFileSync(NVIDIA_INFO_FILE, "utf8"));
      if (nvida_info["run_mode"] === "cpu") {
        binaryFolder = path.join(binaryFolder, "win-cpu");
      } else {
        binaryFolder = path.join(binaryFolder, "win-cuda");
        cudaVisibleDevices = nvida_info["gpu_highest_vram"];
      }
      binaryName = "nitro.exe";
    } else if (process.platform === "darwin") {
      if (process.arch === "arm64") {
        binaryFolder = path.join(binaryFolder, "mac-arm64");
      } else {
        binaryFolder = path.join(binaryFolder, "mac-x64");
      }
      binaryName = "nitro";
    } else {
      let nvida_info = JSON.parse(readFileSync(NVIDIA_INFO_FILE, "utf8"));
      if (nvida_info["run_mode"] === "cpu") {
        binaryFolder = path.join(binaryFolder, "linux-cpu");
      } else {
        binaryFolder = path.join(binaryFolder, "linux-cuda");
        cudaVisibleDevices = nvida_info["gpu_highest_vram"];
      }
      binaryName = "nitro";
    }

    const binaryPath = path.join(binaryFolder, binaryName);
    // Execute the binary
    subprocess = spawn(binaryPath, [1, LOCAL_HOST, PORT], {
      cwd: binaryFolder,
      env: {
        ...process.env,
        CUDA_VISIBLE_DEVICES: cudaVisibleDevices,
      },
    });

    // Handle subprocess output
    subprocess.stdout.on("data", (data) => {
      console.debug(`stdout: ${data}`);
    });

    subprocess.stderr.on("data", (data) => {
      console.error("subprocess error:" + data.toString());
      console.error(`stderr: ${data}`);
    });

    subprocess.on("close", (code) => {
      console.debug(`child process exited with code ${code}`);
      subprocess = null;
      reject(`child process exited with code ${code}`);
    });

    tcpPortUsed.waitUntilUsed(PORT, 300, 30000).then(() => {
      resolve(nitroResourceProbe);
    });
  });
}

/**
 * Get the system resources information
 * TODO: Move to Core so that it can be reused
 */
function getResourcesInfo(): Promise<ResourcesInfo> {
  return new Promise(async (resolve) => {
    const cpu = await osUtils.cpuCount();
    console.log("cpu: ", cpu);
    const response: ResourcesInfo = {
      numCpuPhysicalCore: cpu,
      memAvailable: 0,
    };
    resolve(response);
  });
}

function dispose() {
  // clean other registered resources here
  killSubprocess();
}

module.exports = {
  initModel,
  stopModel,
  killSubprocess,
  dispose,
  updateNvidiaInfo,
};
