import os
import uuid
import struct
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from google import genai
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

app = FastAPI(title="Intelligent Meeting Notes Backend")

# Enable CORS for Chrome Extension / external frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Directory to store audio files
UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

# In-memory sessions database
sessions = {}

# Initialize Gemini SDK Client
api_key = os.getenv("GEMINI_API_KEY")
if not api_key or api_key == "YOUR GEMINI API KEY":
    print("=========================================================================")
    print("WARNING: GEMINI_API_KEY is not configured in .env. API calls will fail.")
    print("=========================================================================")
    client = None
else:
    client = genai.Client(api_key=api_key)

class SessionConfig(BaseModel):
    sampleRate: int = 16000
    channels: int = 1
    bitDepth: int = 16

def write_wav_header(file_path: str, sample_rate: int, channels: int, bit_depth: int):
    """
    Overwrites the first 44 bytes of the raw PCM session file with a valid WAV header.
    """
    file_size = os.path.getsize(file_path)
    data_length = file_size - 44
    if data_length < 0:
        raise ValueError("Audio file contains no recording data.")

    byte_rate = sample_rate * channels * (bit_depth // 8)
    block_align = channels * (bit_depth // 8)

    # 44-byte WAV header binary packaging (little-endian '<')
    header = struct.pack(
        '<4sI4s4sIHHIIHH4sI',
        b'RIFF',                 # Chunk ID
        36 + data_length,        # Chunk Size (36 + data size)
        b'WAVE',                 # Format
        b'fmt ',                 # Subchunk 1 ID
        16,                      # Subchunk 1 Size (16 for PCM)
        1,                       # Audio Format (1 = linear PCM)
        channels,                # Number of channels
        sample_rate,             # Sample Rate
        byte_rate,               # Byte Rate
        block_align,             # Block Align
        bit_depth,               # Bits per Sample
        b'data',                 # Subchunk 2 ID
        data_length              # Subchunk 2 Size (actual audio data length)
    )

    with open(file_path, 'r+b') as f:
        f.seek(0)
        f.write(header)
    print(f"[WAV Utility] Successfully updated WAV header. Audio size: {data_length} bytes.")

@app.post("/api/session/start")
async def start_session(config: SessionConfig):
    session_id = str(uuid.uuid4())
    file_path = os.path.join(UPLOAD_DIR, f"{session_id}.wav")

    # Pre-allocate 44 empty bytes for the WAV header placeholder
    with open(file_path, "wb") as f:
        f.write(b"\x00" * 44)

    sessions[session_id] = {
        "sessionId": session_id,
        "sampleRate": config.sampleRate,
        "channels": config.channels,
        "bitDepth": config.bitDepth,
        "filePath": file_path,
        "status": "recording"
    }

    print(f"[Session Started] ID: {session_id} | Config: {config.sampleRate}Hz, {config.channels}ch, {config.bitDepth}-bit")
    return {"sessionId": session_id}

@app.post("/api/session/{session_id}/chunk")
async def receive_chunk(session_id: str, request: Request):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found or expired")

    session = sessions[session_id]
    if session["status"] != "recording":
        raise HTTPException(status_code=400, detail="Session is no longer accepting audio chunks")

    # Read binary stream chunk from request body
    chunk_data = await request.body()

    # Append to the raw PCM file
    with open(session["filePath"], "ab") as f:
        f.write(chunk_data)

    return {"success": True}

@app.post("/api/session/{session_id}/generate")
async def generate_notes(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found or expired")

    session = sessions[session_id]
    if session["status"] not in ["recording", "processing"]:
         raise HTTPException(status_code=400, detail="Invalid session state")

    session["status"] = "processing"
    file_path = session["filePath"]

    try:
        # 1. Update the WAV header in place
        write_wav_header(file_path, session["sampleRate"], session["channels"], session["bitDepth"])

        # Validate we got data beyond the header
        file_size = os.path.getsize(file_path)
        if file_size <= 44:
            raise HTTPException(status_code=400, detail="No audio data was recorded. Please check your mic connection.")

        # Load dotenv again to pick up runtime .env changes immediately
        load_dotenv()
        current_api_key = os.getenv("GEMINI_API_KEY")
        if not current_api_key or current_api_key == "YOUR_GEMINI_API_KEY_HERE":
            raise HTTPException(
                status_code=500, 
                detail="Gemini Client is not configured. Please add GEMINI_API_KEY to your .env file."
            )
        
        dynamic_client = genai.Client(api_key=current_api_key)

        # 2. Upload the audio file to Gemini File Manager
        print(f"[Gemini] Uploading WAV file: {file_path}")
        audio_file = dynamic_client.files.upload(file=file_path)
        print(f"[Gemini] Upload complete. URI: {audio_file.uri}")

        # 3. Call the generative model to create notes & summary (with multi-model fallback queue)
        print(f"[Gemini] Requesting notes generation for session {session_id}...")
        
        prompt = """You are an expert executive assistant. You are given the audio recording of a meeting. 
        Please listen to the entire audio carefully and generate comprehensive, high-quality, professional meeting notes.
        Your notes should include:
        1. **Executive Summary**: A brief, high-level summary of the meeting.
        2. **Key Discussion Points**: Detailed bullet points of what was discussed, mapping ideas to speakers if identifiable.
        3. **Decisions Made**: A list of all consensus or individual decisions made during the call.
        4. **Action Items**: A clear, actionable checklist of next steps, specifying WHO is assigned to WHAT and WHEN (if mentioned).
        
        Format the entire response in a beautiful, structured Markdown document. Use clear headings, bullet points, and task lists where appropriate."""

        models_to_try = [
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite',
            'gemini-flash-latest'
        ]

        response = None
        last_error = None

        for model_name in models_to_try:
            try:
                print(f"[Gemini] Attempting notes generation with model: {model_name}...")
                response = dynamic_client.models.generate_content(
                    model=model_name,
                    contents=[audio_file, prompt]
                )
                print(f"[Gemini] Successfully generated notes using model: {model_name}!")
                break
            except Exception as api_err:
                last_error = api_err
                print(f"[Gemini Warning] Model {model_name} failed: {str(api_err)}")
                continue

        if response is None:
            raise last_error

        summary_text = response.text
        print(f"[Gemini] Notes generated successfully!")

        # 4. Clean up file from Gemini file storage
        try:
            dynamic_client.files.delete(name=audio_file.name)
            print(f"[Gemini] Deleted temporary file from File Manager: {audio_file.name}")
        except Exception as cleanup_err:
            print(f"[Gemini] Cleanup warning (failed to delete file): {cleanup_err}")

        session["status"] = "completed"
        session["summary"] = summary_text

        # Optional: Clean up local WAV file if you don't want to store recordings on disk
        # os.remove(file_path)

        return {
            "sessionId": session_id,
            "summary": summary_text
        }

    except Exception as e:
        session["status"] = "error"
        print(f"[Error] Processing failed for session {session_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Generation failed: {str(e)}")

# Mount the public static directory at the root to serve index.html
app.mount("/", StaticFiles(directory="public", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # Read port from env or default to 8000
    port = int(os.getenv("PORT", 8000))
    print(f"Starting server on http://127.0.0.1:{port}")
    uvicorn.run("main:app", host="127.0.0.1", port=port, reload=True)
