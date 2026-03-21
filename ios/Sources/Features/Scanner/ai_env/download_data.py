from roboflow import Roboflow

# Initialize with your key
rf = Roboflow(api_key="QJEHTAiXMbnuInRadPdY")

# NOTE: You need to replace these placeholders with your actual IDs 
# You can find these in the URL of your Roboflow project page
# Example: universe.roboflow.com/workspace-id/project-id/version
project = rf.workspace("object-detection-ggkai").project("pokemon_card_detector-aad0t")
dataset = project.version(1).download("coco")

print(f"Dataset downloaded to: {dataset.location}")